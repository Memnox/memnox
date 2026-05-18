import type { ApiRole, DecisionEffect, EnvironmentModes } from '@memnox/core';
import { DECISION_EFFECT } from '@memnox/core';

export const DEFAULT_PORT = 7466;
export const DEFAULT_HOST = '127.0.0.1';
export const DEFAULT_DATA_DIR = '.memnox';
/** How much history a simulation replays; enough to be representative, bounded so it stays fast. */
export const SIMULATION_SAMPLE_LIMIT = 1_000;

export const DEFAULT_AUDIT_LIMIT = 50;
/** Per-agent ceiling on the check endpoint; 0 disables. Generous — it stops floods, not work. */
export const DEFAULT_CHECK_RATE_LIMIT_PER_MINUTE = 600;
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
  policyFile?: string;
  defaultEffect: DecisionEffect;
  /** Per-environment enforcement; unset means every environment is monitored. */
  enforcement?: EnvironmentModes;
  /** RBAC keys for management routes. Empty on a local runtime = open (local mode). */
  apiKeys: ApiKeyConfig[];
  /** Legacy single admin token — equivalent to an apiKeys entry with role "admin". */
  adminToken?: string;
  /** Enables the deterministic behavioral advisor (novel actions, bursts, probing). */
  behaviorGuard: boolean;
  /** Requires human approval for high/critical actions from low-trust agents. */
  trustGuard: boolean;
  /** Enables decision memory: team decisions constrain actions. */
  memoryEnabled: boolean;
  /** Scans written content for secrets/PII before allowing file writes. */
  contentShield: boolean;
  /** Reads past shell indirection so a wrapped destructive command still matches. */
  shellGuard: boolean;
  /** Open holds one agent may accumulate before further ones are refused. */
  maxPendingApprovals?: number;
  /** Caps cumulative llm.spend tokens per session; unset = no cap. */
  sessionTokenBudget?: number;
  /** Slack-compatible incoming-webhook URL notified on new pending approvals. */
  approvalWebhookUrl?: string;
  /** Enables the Slack interactive-approval endpoint when set. */
  slackSigningSecret?: string;
  /** Encrypts local stores (agents, approvals, decisions, audit) at rest when set. */
  dataEncryptionKey?: string;
  /** Accept HS256 agent JWTs signed with this value (sub = agent ID). */
  agentJwtSecret?: string;
  agentJwtIssuer?: string;
  /** Per-agent requests/minute on /v1/actions/check; 0 disables. */
  checkRateLimitPerMinute: number;
  /** Postgres connection string; unset = local JSON/JSONL file stores. */
  databaseUrl?: string;
  /** Redis connection string; unset = per-process locks and rate limits. */
  redisUrl?: string;
  /** Prune audit events older than this many days; 0 disables the sweep. */
  auditRetentionDays: number;
  /** All three TLS paths set = HTTPS with opt-in client-certificate agent auth. */
  tlsCertFile?: string;
  tlsKeyFile?: string;
  tlsCaFile?: string;
  /** Code-graph snapshot (`memnox graph build`) enabling blast-radius escalation. */
  codeGraphFile?: string;
  /** Path patterns a code change must not reach without a human, e.g. ["*payment/*"]. */
  protectedPaths: string[];
  /** BYOK embedding key; unset = deterministic keyword search only. */
  embeddingApiKey?: string;
  embeddingModel?: string;
  /** Must match the model's output size; the pgvector column type fixes it. */
  embeddingDimensions?: number;
  /** Governs dependency.add: known-vulnerable versions and unacceptable licenses. */
  dependencyGuard: boolean;
  /** Let the dependency guard read licenses from the npm registry (adds a network call). */
  dependencyLicenseLookup: boolean;
}

export const DEFAULT_RUNTIME_CONFIG: RuntimeConfig = {
  port: DEFAULT_PORT,
  host: DEFAULT_HOST,
  dataDir: DEFAULT_DATA_DIR,
  defaultEffect: DECISION_EFFECT.ALLOW,
  apiKeys: [],
  behaviorGuard: false,
  trustGuard: false,
  memoryEnabled: true,
  contentShield: true,
  shellGuard: true,
  checkRateLimitPerMinute: DEFAULT_CHECK_RATE_LIMIT_PER_MINUTE,
  auditRetentionDays: DEFAULT_AUDIT_RETENTION_DAYS,
  protectedPaths: [],
  dependencyGuard: false,
  dependencyLicenseLookup: false,
};

/** Merge overrides onto defaults without letting explicit undefined clobber a default. */
export function resolveConfig(overrides: Partial<RuntimeConfig>): RuntimeConfig {
  const defined = Object.fromEntries(
    Object.entries(overrides).filter(([, value]) => value !== undefined),
  );
  return { ...DEFAULT_RUNTIME_CONFIG, ...defined };
}
