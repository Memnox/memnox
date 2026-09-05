import { execFile } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { SqliteEventStore, databasePathFor } from '../src/event/sqlite-store';

const run = promisify(execFile);
const WRITERS = 5;
const PER_WRITER = 200;

/**
 * Real processes, not promises: WAL exists so an interceptor, the proxy and a daemon can write
 * while `timeline` reads, and only separate processes actually take separate locks.
 */
const WRITER = `
const Database = require('better-sqlite3');
const db = new Database(process.argv[2]);
db.pragma('busy_timeout = 10000');
const insert = db.prepare(
  'INSERT OR IGNORE INTO events (id, schemaVersion, at, sessionId, agent, actorType, surface, operation, class, effect, mode, reason)' +
  " VALUES (?, 1, ?, 'ses', 'claude-code', 'agent', 'shell', 'echo', 'read', 'allow', 'observe', 'ok')"
);
const who = process.argv[3];
for (let n = 0; n < ${PER_WRITER}; n += 1) {
  insert.run(who + '_' + n, new Date(Date.now() + n).toISOString());
}
db.close();
`;

describe('five processes writing at once', () => {
  it('loses nothing, because WAL lets writers queue instead of failing', async () => {
    const home = await mkdtemp(join(tmpdir(), 'memnox-conc-'));
    const path = databasePathFor(home);

    // The schema has to exist before the writers open it.
    const store = SqliteEventStore.forHome(home);
    store.close();

    const script = join(home, 'writer.cjs');
    await writeFile(script, WRITER);

    await Promise.all(
      Array.from({ length: WRITERS }, (_unused, index) =>
        run(process.execPath, [script, path, `w${index}`], {
          cwd: join(process.cwd(), 'packages/core'),
        }),
      ),
    );

    const reopened = SqliteEventStore.forHome(home);
    expect(await reopened.count()).toBe(WRITERS * PER_WRITER);
    reopened.close();
  }, 30_000);

  it('reads while a writer is still going', async () => {
    const home = await mkdtemp(join(tmpdir(), 'memnox-conc-read-'));
    const path = databasePathFor(home);
    const store = SqliteEventStore.forHome(home);

    const script = join(home, 'writer.cjs');
    await writeFile(script, WRITER);
    const writing = run(process.execPath, [script, path, 'w'], {
      cwd: join(process.cwd(), 'packages/core'),
    });

    // A reader must never be locked out mid-write; that stall is what WAL prevents.
    await expect(store.query({ limit: 5 })).resolves.toBeInstanceOf(Array);
    await writing;

    expect(await store.count()).toBe(PER_WRITER);
    store.close();
  }, 30_000);
});
