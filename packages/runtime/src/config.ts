import type { ApiRole, DecisionEffect, EnvironmentModes } from '@memnox/core';
import { DECISION_EFFECT, DEFAULT_HOST, DEFAULT_PORT } from '@memnox/core';

/* Declared in core so the CLI can read a default port without loading a web server. */
export { DEFAULT_HOST, DEFAULT_PORT };
export const DEFAULT_DATA_DIR = '.memnox';
/** Enough history to be representative, bounded so a simulation stays fast. */
export const SIMULATION_SAMPLE_LIMIT = 1_000;

export const DEFAULT_AUDIT_LIMIT = 50;
/** Per-agent ceiling on the check endpoint; 0 disables. Generous — it stops floods, not work. */
export const DEFAULT_CHECK_RATE_LIMIT_PER_MINUTE = 600;
/** A tenth of the check budget: the two calls cost very different things. */
export const DEFAULT_ASK_RATE_LIMIT_PER_MINUTE = 60;
export const MAX_AUDIT_LIMIT = 500;
/** Days of audit history kept by the retention sweep; 0 = keep everything. */
export const DEFAULT_AUDIT_RETENTION_DAYS = 0;
/** Fallback approver group for advisor-driven escalations (memory conflicts, behavior). */
export const DEFAULT_ADVISOR_APPROVERS: readonly string[] = ['team-lead'];

export interface ApiKeyConfig {
  token: string;
  role: ApiRole;
}

export interface RuntimeConfig {
  port: number;
  host: string;
  /** Directory for local persistence (audit log, agent registry, decision memory). */
  dataDir: string;
  /** One runtime is one tenant, so a control plane reaching many needs a prefix. */
  basePath?: string;
  policyFile?: string;
  /** Extra rule sources, e.g. a second repository of the same project. */
  policyFiles?: string[];
  /** JSON file listing rule sources; re-read on reload so a new repo can join a live runtime. */
  policyRegistryFile?: string;
  defaultEffect: DecisionEffect;
  /** Per-environment enforcement; unset means every environment is observed. */
  enforcement?: EnvironmentModes;
  /** RBAC keys for management routes. Empty on a local runtime = open (local mode). */
  apiKeys: ApiKeyConfig[];
  /** Legacy single admin token — equivalent to an apiKeys entry with role "admin". */
  adminToken?: string;
  /** Serve management routes unauthenticated when no keys are set. */
  allowLocalAdmin: boolean;
  /** Open holds one agent may accumulate before further ones are refused. */
  maxPendingApprovals?: number;
  /** Accept HS256 agent JWTs signed with this value (sub = agent ID). */
  agentJwtSecret?: string;
  agentJwtIssuer?: string;
  /** Per-agent requests/minute on /v1/actions/check; 0 disables. */
  checkRateLimitPerMinute: number;
  /** Per-agent ceiling on the organization protocol; see the constant for why it differs. */
  askRateLimitPerMinute: number;
  /** Prune audit events older than this many days; 0 disables the sweep. */
  auditRetentionDays: number;
}

export const DEFAULT_RUNTIME_CONFIG: RuntimeConfig = {
  port: DEFAULT_PORT,
  host: DEFAULT_HOST,
  dataDir: DEFAULT_DATA_DIR,
  defaultEffect: DECISION_EFFECT.ALLOW,
  apiKeys: [],
  allowLocalAdmin: false,
  checkRateLimitPerMinute: DEFAULT_CHECK_RATE_LIMIT_PER_MINUTE,
  askRateLimitPerMinute: DEFAULT_ASK_RATE_LIMIT_PER_MINUTE,
  auditRetentionDays: DEFAULT_AUDIT_RETENTION_DAYS,
};

/** Merge overrides onto defaults without letting explicit undefined clobber a default. */
export function resolveConfig(overrides: Partial<RuntimeConfig>): RuntimeConfig {
  const defined = Object.fromEntries(
    Object.entries(overrides).filter(([, value]) => value !== undefined),
  );
  return { ...DEFAULT_RUNTIME_CONFIG, ...defined };
}
