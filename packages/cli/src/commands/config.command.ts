/**
 * `memnox config`: read and change how this machine is governed. `get` prints one bare
 * value so a script can read it; everything else draws on the rail.
 */

import { homedir } from 'node:os';
import type { Command } from 'commander';
import {
  applyConfigValue,
  configKeys,
  isConfigKey,
  loadOrCreateConfig,
  readConfigValue,
  saveConfig,
  validateConfigValue,
  type ConfigKey,
} from '@memnox/core';
import type { CliContext } from '../cli-context';

function assertKey(key: string): asserts key is ConfigKey {
  if (isConfigKey(key)) return;
  throw new Error(`No setting named "${key}". Try one of: ${configKeys().join(', ')}`);
}

export function registerConfigCommand(
  program: Command,
  context: CliContext,
  home: () => string = homedir,
): void {
  const config = program
    .command('config')
    .description('Read and change how this machine is governed');

  config
    .command('get <key>')
    .description('Print one setting')
    .action(async (key: string) => runGet(context, home, key));

  config
    .command('set <key> <value>')
    .description('Change one setting')
    .action(async (key: string, value: string) => runSet(context, home, key, value));

  config
    .command('list')
    .description('Print every setting')
    .action(async () => runList(context, home));
}

/** One value, printed bare with no rail, so a script reads it without stripping anything. */
async function runGet(
  context: CliContext,
  home: () => string,
  key: string,
): Promise<void> {
  assertKey(key);
  const current = await loadOrCreateConfig(home());
  context.out.line(readConfigValue(current, key));
}

/** Changes one setting, and says what it was before. */
async function runSet(
  context: CliContext,
  home: () => string,
  key: string,
  value: string,
): Promise<void> {
  assertKey(key);
  const parsed = validateConfigValue(key, value);
  if (parsed.error !== undefined) throw new Error(parsed.error);

  const { flow } = context;
  flow.open('memnox config set');
  const current = await loadOrCreateConfig(home());
  const before = readConfigValue(current, key);
  await saveConfig(home(), applyConfigValue(current, key, value));

  flow.rows('Changed', [
    { label: key, value: `${before} → ${value}` },
    { label: 'from now', value: 'every seam on this machine reads the new value' },
  ]);
  flow.close(`${key} is ${value}.`);
  flow.hint('Put it back with "memnox config set" and the old value.');
}

/** Every setting this machine has, and what each one is. */
async function runList(context: CliContext, home: () => string): Promise<void> {
  const { flow } = context;
  flow.open('memnox config list');
  const current = await loadOrCreateConfig(home());

  flow.table(
    'This machine',
    ['Setting', 'Value'],
    configKeys().map((key) => [key, readConfigValue(current, key)]),
  );
  flow.close(`${configKeys().length} setting(s).`);
  flow.hint('Change one with "memnox config set <key> <value>".');
}
