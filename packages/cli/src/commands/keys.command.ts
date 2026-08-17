import { randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import type { Command } from 'commander';
import {
  connectPostgres,
  rewrapTable,
  tableKeyUsage,
  REWRAPPABLE_TABLES,
  type SqlClient,
} from '@memnox/postgres';
import {
  DEFAULT_DATA_DIR,
  ENCRYPTION_MODE,
  KeyringCodec,
  keyUsageForDataDir,
  recodeValue,
  resolveKeyring,
  rewrapDataDir,
  type Keyring,
} from '@memnox/runtime';
import type { CliContext } from '../cli-context';

/** 32 bytes of entropy each — a generated key is never a memorable passphrase. */
const SECRET_BYTES = 32;
const SALT_BYTES = 16;

interface KeyOptions {
  dataDir: string;
  keyringFile?: string;
  databaseUrl?: string;
}

/** Reading and rewrapping must see every key, including ones already retired. */
const REWRAP_MODE = ENCRYPTION_MODE.PERMISSIVE;

export function registerKeysCommand(program: Command, context: CliContext): void {
  const keys = program
    .command('keys')
    .description('Manage the at-rest encryption keyring');

  keys
    .command('generate')
    .description('Print a new keyring, or add a key to an existing one')
    .option('--id <id>', 'key id; defaults to a date-stamped name')
    .option('--keyring-file <path>', 'existing keyring to extend, and where to write')
    .action(async (options: { id?: string; keyringFile?: string }) => {
      const id =
        options.id ?? `k${new Date().toISOString().slice(0, 10).replace(/-/g, '')}`;
      const generated = {
        id,
        secret: randomBytes(SECRET_BYTES).toString('base64'),
        salt: randomBytes(SALT_BYTES).toString('base64'),
      };
      const existing =
        options.keyringFile === undefined ? null : await readKeyring(options.keyringFile);
      const keyring: Keyring =
        existing === null
          ? { activeKeyId: id, keys: [generated] }
          : { activeKeyId: id, keys: [...existing.keys, generated] };

      if (options.keyringFile === undefined) {
        // The JSON is the payload and nothing else may join it: the obvious way
        // to use this command is `> keyring.json`, and advice printed on the
        // same stream produced a file the runtime rejected as malformed.
        context.out.line(JSON.stringify(keyring, null, 2));
        context.out.note('');
        context.out.note(
          'Store this somewhere the runtime can read and you can back up.',
        );
        context.out.note('Losing a key means losing every record written under it.');
        return;
      }
      await writeFile(
        options.keyringFile,
        `${JSON.stringify(keyring, null, 2)}\n`,
        'utf8',
      );
      context.out.line(`Added key "${id}" to ${options.keyringFile} and made it active.`);
      context.out.line(`Run "memnox keys rewrap" to move existing records onto it.`);
    });

  keys
    .command('status')
    .description('Count stored records by the key that encrypted them')
    .option('--data-dir <path>', 'local data directory', DEFAULT_DATA_DIR)
    .option('--keyring-file <path>', 'keyring to read with')
    .option('--database-url <url>', 'Postgres connection string')
    .action(async (options: KeyOptions) => {
      const { codec, sql } = await open(options);
      try {
        const rows = [
          ...(await keyUsageForDataDir(options.dataDir, codec)),
          ...(sql === null
            ? []
            : await Promise.all(
                REWRAPPABLE_TABLES.map(async (table) => ({
                  source: table,
                  byKeyId: (
                    await tableKeyUsage(sql, table, (stored) => codec.keyIdOf(stored))
                  ).byKeyId,
                })),
              )),
        ];
        if (rows.length === 0) {
          context.out.line('No stores found — nothing has been written yet.');
          return;
        }
        context.out.line(`Active key: ${codec.activeKey}`);
        for (const row of rows) {
          const counts = Object.entries(row.byKeyId)
            .map(([keyId, count]) => `${keyId}=${count}`)
            .join(' ');
          context.out.line(`  ${row.source.padEnd(22)} ${counts || 'empty'}`);
        }
      } finally {
        if (sql !== null) await sql.end();
      }
    });

  keys
    .command('rewrap')
    .description('Re-encrypt every record under the active key')
    .option('--data-dir <path>', 'local data directory', DEFAULT_DATA_DIR)
    .option('--keyring-file <path>', 'keyring to read with')
    .option('--database-url <url>', 'Postgres connection string')
    .action(async (options: KeyOptions) => {
      const { codec, sql } = await open(options);
      try {
        const results = await rewrapDataDir(options.dataDir, codec);
        if (sql !== null) {
          for (const table of REWRAPPABLE_TABLES) {
            const rewrapped = await rewrapTable(sql, table, (stored) =>
              recodeValue(codec, stored),
            );
            results.push({ source: table, values: rewrapped, rewrapped });
          }
        }
        const total = results.reduce((sum: number, result) => sum + result.rewrapped, 0);
        for (const result of results) {
          context.out.line(`  ${result.source.padEnd(22)} ${result.rewrapped} rewrapped`);
        }
        context.out.line(
          total === 0
            ? `Everything is already on key "${codec.activeKey}".`
            : `Rewrapped ${total} record(s) onto key "${codec.activeKey}".`,
        );
        context.out.line('Retire the old key only once this reports 0 for it.');
        // A running runtime read the keyring at boot and does not hold the key
        // these records were just moved onto, so its next read fails. Saying so
        // here is the difference between a rotation and an outage.
        if (total > 0) {
          context.out.note('');
          context.out.note(
            'Restart any running runtime: it loaded the keyring at startup and cannot read these records until it does.',
          );
        }
      } finally {
        if (sql !== null) await sql.end();
      }
    });
}

/** One place that turns flags into a codec, so status and rewrap cannot disagree. */
async function open(
  options: KeyOptions,
): Promise<{ codec: KeyringCodec; sql: SqlClient | null }> {
  const keyring = await resolveKeyring({
    ...(options.keyringFile === undefined ? {} : { keyringFile: options.keyringFile }),
  });
  if (keyring === null) {
    throw new Error(
      'no keyring configured — pass --keyring-file or set $MEMNOX_KEYRING_FILE',
    );
  }
  return {
    codec: new KeyringCodec(keyring, REWRAP_MODE),
    sql: options.databaseUrl === undefined ? null : connectPostgres(options.databaseUrl),
  };
}

async function readKeyring(path: string): Promise<Keyring | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as Keyring;
  } catch (error) {
    // A first "keys generate --keyring-file" creates the file; anything else is real.
    if (
      typeof error === 'object' &&
      error !== null &&
      (error as { code?: unknown }).code === 'ENOENT'
    ) {
      return null;
    }
    throw error;
  }
}
