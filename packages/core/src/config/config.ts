import {
  ENFORCEMENT_MODE,
  type EnforcementMode,
} from '../constants/enforcement.constants';

export const MEMNOX_HOME = '.memnox';
export const CONFIG_FILE = 'config.toml';

/** Observe-first: a runtime that denied on the first run would be uninstalled by lunch. */
export const FIRST_RUN_MODE: EnforcementMode = ENFORCEMENT_MODE.OBSERVE;

export interface MemnoxConfig {
  mode: EnforcementMode;
  /** Days of events kept before `memnox purge` drops them. */
  retentionDays: number;
  /** Forward a call when the gate cannot answer. A firewall fails closed by default. */
  failOpen: boolean;
  /** Counts only, opt-in, never contents. Absent means never asked. */
  telemetry: boolean;
}

export const DEFAULT_CONFIG: MemnoxConfig = {
  mode: FIRST_RUN_MODE,
  retentionDays: 30,
  failOpen: false,
  telemetry: false,
};

const KEYS = ['mode', 'retentionDays', 'failOpen', 'telemetry'] as const;
export type ConfigKey = (typeof KEYS)[number];

export function isConfigKey(value: string): value is ConfigKey {
  return (KEYS as readonly string[]).includes(value);
}

export function configKeys(): readonly ConfigKey[] {
  return KEYS;
}

function isEnforcementMode(value: string): value is EnforcementMode {
  return Object.values(ENFORCEMENT_MODE).includes(value as EnforcementMode);
}

/**
 * A hand-rolled reader for the flat key/value subset this file is: adding a TOML
 * parser to the zero-dependency package to read four scalars is a dependency nobody
 * needs. Anything richer than `key = value` belongs in a policy file.
 */
export function parseConfig(raw: string): MemnoxConfig {
  const config: MemnoxConfig = { ...DEFAULT_CONFIG };
  for (const line of raw.split('\n')) {
    const text = line.trim();
    if (text === '' || text.startsWith('#') || text.startsWith('[')) continue;
    const split = text.indexOf('=');
    if (split === -1) continue;
    const key = text.slice(0, split).trim();
    const value = text
      .slice(split + 1)
      .trim()
      .replace(/^["']|["']$/g, '');
    if (key === 'mode' && isEnforcementMode(value)) config.mode = value;
    if (key === 'retentionDays') {
      const days = Number(value);
      if (Number.isInteger(days) && days > 0) config.retentionDays = days;
    }
    if (key === 'failOpen') config.failOpen = value === 'true';
    if (key === 'telemetry') config.telemetry = value === 'true';
  }
  return config;
}

/** Written with the comments a person reads before changing a mode by hand. */
export function renderConfig(config: MemnoxConfig): string {
  return [
    '# Memnox — written on first run, yours to edit.',
    '',
    '# off | observe | advise | enforce. Observe records the real verdict and denies nothing.',
    `mode = "${config.mode}"`,
    '',
    '# Days of history kept. "memnox purge" drops anything older.',
    `retentionDays = ${config.retentionDays}`,
    '',
    '# Let a call through when the gate cannot answer. A firewall fails closed.',
    `failOpen = ${config.failOpen}`,
    '',
    '# Counts only, never contents, and only if you turn it on.',
    `telemetry = ${config.telemetry}`,
    '',
  ].join('\n');
}

export interface ConfigParse {
  value: string;
  error?: string;
}

/** Validation lives beside the schema, so the CLI only has to print what it is told. */
export function validateConfigValue(key: ConfigKey, value: string): ConfigParse {
  if (key === 'mode') {
    if (!isEnforcementMode(value)) {
      return {
        value,
        error: `mode must be one of ${Object.values(ENFORCEMENT_MODE).join(', ')}`,
      };
    }
    return { value };
  }
  if (key === 'retentionDays') {
    const days = Number(value);
    if (!Number.isInteger(days) || days <= 0) {
      return { value, error: 'retentionDays must be a whole number of days above zero' };
    }
    return { value };
  }
  if (value !== 'true' && value !== 'false') {
    return { value, error: `${key} must be true or false` };
  }
  return { value };
}

export function applyConfigValue(
  config: MemnoxConfig,
  key: ConfigKey,
  value: string,
): MemnoxConfig {
  if (key === 'mode') return { ...config, mode: value as EnforcementMode };
  if (key === 'retentionDays') return { ...config, retentionDays: Number(value) };
  if (key === 'failOpen') return { ...config, failOpen: value === 'true' };
  return { ...config, telemetry: value === 'true' };
}

export function readConfigValue(config: MemnoxConfig, key: ConfigKey): string {
  return String(config[key]);
}
