import { ENFORCEMENT_MODE, isEnforcementMode, type EnvironmentModes } from '@memnox/core';

const PAIR_SEPARATOR = ',';
const KEY_SEPARATOR = '=';
/** The key that sets the fallback rather than a named environment. */
const DEFAULT_KEY = 'default';

const MODES = Object.values(ENFORCEMENT_MODE).join(' | ');

/** A bare mode sets the default and nothing else. */
export function parseEnforcement(spec: string): EnvironmentModes {
  const trimmed = spec.trim();
  if (trimmed.length === 0) throw new Error('--enforcement needs a value');

  if (isEnforcementMode(trimmed)) return { default: trimmed };

  const modes: EnvironmentModes = {};
  const environments: Record<string, string> = {};

  for (const rawPair of trimmed.split(PAIR_SEPARATOR)) {
    const pair = rawPair.trim();
    if (pair.length === 0) continue;

    const index = pair.indexOf(KEY_SEPARATOR);
    if (index === -1) {
      throw new Error(`--enforcement "${pair}" must be <environment>=<mode> (${MODES})`);
    }
    const key = pair.slice(0, index).trim();
    const mode = pair.slice(index + 1).trim();
    if (key.length === 0)
      throw new Error('--enforcement entry is missing an environment');
    if (!isEnforcementMode(mode)) {
      throw new Error(`--enforcement mode "${mode}" must be one of: ${MODES}`);
    }
    if (key === DEFAULT_KEY) {
      modes.default = mode;
      continue;
    }
    // A repeated environment is a typo, not an override — say so rather than pick one.
    if (environments[key] !== undefined) {
      throw new Error(`--enforcement names "${key}" twice`);
    }
    environments[key] = mode;
  }

  if (Object.keys(environments).length > 0) {
    modes.environments = environments as EnvironmentModes['environments'];
  }
  return modes;
}
