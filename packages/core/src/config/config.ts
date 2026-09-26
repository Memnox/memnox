/** This machine's own settings file, and the names every package shares for where Memnox lives. */
import {
  ENFORCEMENT_MODE,
  type EnforcementMode,
} from '../constants/enforcement.constants';
import { isEnforcementMode } from '../domain/enforcement';
import { DEFAULT_NOTICE_WARMUP_DAYS } from '../notice/notice.constants';
import {
  APPROVAL_ROUTE,
  approvalRouteOf,
  type ApprovalRoute,
} from '../constants/approval-route.constants';

/** Everything this product writes lives under here, so no command writes where another does not look. */
export const MEMNOX_HOME = '.memnox';

/** The file naming every rule file in force, which is what the seams load. */
export const POLICY_REGISTRY_FILE = 'policies.json';

/** Set by `memnox run` and read by every seam, so one agent's actions group into one session. */
export const SESSION_VAR = 'MEMNOX_SESSION';
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
   * Agents somebody decided are allowed here; anything else that acts is reported as
   * unregistered. Empty means nobody has decided yet, rather than all approved.
   */
  approvedAgents: string[];
  /** Ask about an allowed action that is new, completes a chain, or follows injection. */
  noticeUnusual: boolean;
  /** Days after setup when unusual actions are only recorded, so day one asks nothing. */
  noticeWarmupDays: number;
  /**
   * Where a question goes when the agent cannot show its own prompt: always the agent
   * session, and with `both` the person's Slack or Discord DM as well.
   */
  approvals: ApprovalRoute;
}

export const DEFAULT_CONFIG: MemnoxConfig = {
  mode: FIRST_RUN_MODE,
  retentionDays: 30,
  failOpen: false,
  telemetry: false,
  approvedAgents: [],
  noticeUnusual: true,
  noticeWarmupDays: DEFAULT_NOTICE_WARMUP_DAYS,
  approvals: APPROVAL_ROUTE.SESSION,
};

const KEYS = [
  'mode',
  'retentionDays',
  'failOpen',
  'telemetry',
  'approvedAgents',
  'noticeUnusual',
  'noticeWarmupDays',
  'approvals',
] as const;
export type ConfigKey = (typeof KEYS)[number];

export function isConfigKey(value: string): value is ConfigKey {
  return (KEYS as readonly string[]).includes(value);
}

export function configKeys(): readonly ConfigKey[] {
  return KEYS;
}

/**
 * A hand-rolled reader for the flat `key = value` subset this file is, rather than a TOML
 * dependency to read four scalars. Anything richer belongs in a policy file.
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
    if (key === 'noticeUnusual') config.noticeUnusual = value !== 'false';
    if (key === 'noticeWarmupDays' && isWholeDays(value)) {
      config.noticeWarmupDays = Number(value);
    }
    if (key === 'approvals')
      config.approvals = approvalRouteOf(value) ?? config.approvals;
  }
  return config;
}

/** Zero is allowed: somebody who wants questions from the first minute can have them. */
function isWholeDays(value: string): boolean {
  const days = Number(value);
  return value !== '' && Number.isInteger(days) && days >= 0;
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
    '# Memnox: written on first run, yours to edit.',
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
    '# Ask about an allowed action that is new for the agent, completes a chain, or',
    '# follows a tool result that read like instructions. Follows mode above.',
    `noticeUnusual = ${config.noticeUnusual}`,
    '',
    '# Days after setup when those are only recorded, so day one is not a wall of asks.',
    `noticeWarmupDays = ${config.noticeWarmupDays}`,
    '',
    '# session | both. A question the agent cannot show its own prompt for is always',
    '# asked in the agent session; both also sends it to your Slack or Discord DM.',
    `approvals = "${config.approvals}"`,
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
  if (key === 'approvals') {
    return approvalRouteOf(value) !== null
      ? { value }
      : {
          value,
          error: `approvals must be one of ${Object.values(APPROVAL_ROUTE).join(', ')}`,
        };
  }
  if (key === 'noticeWarmupDays') {
    return isWholeDays(value)
      ? { value }
      : { value, error: 'noticeWarmupDays must be a whole number of days, zero or more' };
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
  // validateConfigValue has already refused anything that is not a mode.
  if (key === 'mode') return { ...config, mode: value as EnforcementMode };
  if (key === 'retentionDays') return { ...config, retentionDays: Number(value) };
  if (key === 'failOpen') return { ...config, failOpen: value === 'true' };
  if (key === 'approvedAgents') return { ...config, approvedAgents: splitList(value) };
  if (key === 'noticeUnusual') return { ...config, noticeUnusual: value === 'true' };
  if (key === 'noticeWarmupDays') return { ...config, noticeWarmupDays: Number(value) };
  if (key === 'approvals')
    return { ...config, approvals: approvalRouteOf(value) ?? config.approvals };
  return { ...config, telemetry: value === 'true' };
}

export function readConfigValue(config: MemnoxConfig, key: ConfigKey): string {
  const value = config[key];
  return Array.isArray(value) ? value.join(', ') : String(value);
}

/**
 * Three states, not two, because "nobody has decided" reported as "not approved" would
 * flag every agent on a machine where the list was never filled in.
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
