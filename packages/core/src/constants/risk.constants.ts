export const RISK_LEVEL = {
  LOW: 'low',
  MEDIUM: 'medium',
  HIGH: 'high',
  CRITICAL: 'critical',
} as const;

export type RiskLevel = (typeof RISK_LEVEL)[keyof typeof RISK_LEVEL];

export const RISK_ORDER: readonly RiskLevel[] = [
  RISK_LEVEL.LOW,
  RISK_LEVEL.MEDIUM,
  RISK_LEVEL.HIGH,
  RISK_LEVEL.CRITICAL,
];

/** Action verbs that read state without changing it. */
export const READ_ONLY_VERBS: readonly string[] = [
  'read',
  'get',
  'list',
  'query',
  'search',
];

/** Action verbs that change state reversibly. */
export const MUTATING_VERBS: readonly string[] = [
  'create',
  'update',
  'modify',
  'write',
  'deploy',
  'restart',
];

/** Action verbs that destroy or exfiltrate — highest baseline risk. */
export const DESTRUCTIVE_VERBS: readonly string[] = [
  'delete',
  'drop',
  'destroy',
  'truncate',
  'export',
  'purge',
];

/** Environments where risk is escalated one level. */
export const RISK_ESCALATION_ENVIRONMENTS: readonly string[] = ['production', 'prod'];
