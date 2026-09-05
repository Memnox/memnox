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
  /**
   * Agents somebody decided are allowed here. Anything else that acts is reported as
   * unregistered — which is the whole of shadow-agent detection: nobody approved it,
   * and until now nothing noticed. Empty means nobody has decided yet, which is
   * reported as such rather than as "everything is approved".
   */
  approvedAgents: string[];
}

export const DEFAULT_CONFIG: MemnoxConfig = {
  mode: FIRST_RUN_MODE,
  retentionDays: 30,
  failOpen: false,
  telemetry: false,
  approvedAgents: [],
};

const KEYS = [
  'mode',
  'retentionDays',
  'failOpen',
  'telemetry',
  'approvedAgents',
] as const;
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
    if (key === 'approvedAgents') config.approvedAgents = splitList(value);
  }
  return config;
}

/** A comma-separated list, which is what a flat key/value file can honestly hold. */
function splitList(value: string): string[] {
  return value
    .replace(/^\[|\]$/g, '')
    .split(',')
    .map((each) => each.trim().replace(/^["']|["']$/g, ''))
    .filter((each) => each !== '');
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
    '# Agents you have decided are allowed here. Anything else that acts is reported',
    '# as unregistered. Empty means nobody has decided yet, not that all are approved.',
    `approvedAgents = "${config.approvedAgents.join(', ')}"`,
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
  if (key === 'approvedAgents') return { value };
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
  if (key === 'approvedAgents') return { ...config, approvedAgents: splitList(value) };
  return { ...config, telemetry: value === 'true' };
}

export function readConfigValue(config: MemnoxConfig, key: ConfigKey): string {
  const value = config[key];
  return Array.isArray(value) ? value.join(', ') : String(value);
}

/**
 * Three states, not two. "Nobody has decided" is different from "this agent is not
 * approved", and reporting the first as the second would flag every agent on a machine
 * where the list was simply never filled in.
 */
export const AGENT_APPROVAL = {
  APPROVED: 'approved',
  UNREGISTERED: 'unregistered',
  UNDECIDED: 'undecided',
} as const;

export type AgentApproval = (typeof AGENT_APPROVAL)[keyof typeof AGENT_APPROVAL];

export function approvalOf(agent: string, approved: readonly string[]): AgentApproval {
  if (approved.length === 0) return AGENT_APPROVAL.UNDECIDED;
  return approved.includes(agent) ? AGENT_APPROVAL.APPROVED : AGENT_APPROVAL.UNREGISTERED;
}
