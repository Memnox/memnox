import { homedir } from 'node:os';
import {
  ENFORCEMENT_MODE,
  loadOrCreateConfig,
  saveConfig,
  type EnforcementMode,
} from '@memnox/core';
import type { CliContext } from '../cli-context';

/**
 * Moving this machine between observe and enforce, one line in `config.toml`. It prints
 * what the mode was too, because somebody flipping this switch needs to see it move.
 */
export async function runMode(context: CliContext, enforce: boolean): Promise<void> {
  const { flow } = context;
  const mode: EnforcementMode = enforce
    ? ENFORCEMENT_MODE.ENFORCE
    : ENFORCEMENT_MODE.OBSERVE;
  const home = homedir();
  const config = await loadOrCreateConfig(home);
  await saveConfig(home, { ...config, mode });

  flow.rows('Mode', [
    { label: 'was', value: config.mode },
    { label: 'now', value: mode },
    {
      label: 'means',
      value: enforce ? 'verdicts bite' : 'verdicts are recorded and nothing is denied',
    },
  ]);
  flow.close(`This machine is in ${mode}.`);
  flow.hint(
    enforce
      ? '"memnox protect --observe" puts it back.'
      : '"memnox protect --enforce" makes verdicts bite.',
  );
}
