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
    .action(async (key: string) => {
      assertKey(key);
      const current = await loadOrCreateConfig(home());
      context.out.line(readConfigValue(current, key));
    });

  config
    .command('set <key> <value>')
    .description('Change one setting')
    .action(async (key: string, value: string) => {
      assertKey(key);
      const parsed = validateConfigValue(key, value);
      if (parsed.error !== undefined) throw new Error(parsed.error);

      const current = await loadOrCreateConfig(home());
      const before = readConfigValue(current, key);
      await saveConfig(home(), applyConfigValue(current, key, value));
      context.out.line(`${key}: ${before} → ${value}`);
    });

  config
    .command('list')
    .description('Print every setting')
    .action(async () => {
      const current = await loadOrCreateConfig(home());
      for (const key of configKeys()) {
        context.out.line(`${key.padEnd(15)}${readConfigValue(current, key)}`);
      }
    });
}
