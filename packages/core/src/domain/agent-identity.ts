import type { AgentKind, AgentStatus } from '../constants/agent.constants';
import {
  TRUST_PENALTY_PER_BLOCK,
  TRUST_RECOVERY_ALLOWED_ACTIONS,
  TRUST_SCORE_MAX,
  TRUST_SCORE_MIN,
} from '../constants/agent.constants';

export interface AgentActionStats {
  allowed: number;
  blocked: number;
  approvalsRequested: number;
}

export interface AgentIdentity {
  id: string;
  name: string;
  kind: AgentKind;
  status: AgentStatus;
  /** SHA-256 of the agent token — the plain token is shown once at registration. */
  tokenHash: string;
  createdAt: string;
  stats: AgentActionStats;
  /** Action-name patterns this agent may attempt; unset or empty = unrestricted. */
  capabilities?: string[];
  /** Last credential rotation, when one has happened. */
  rotatedAt?: string;
  /** Owning org/workspace; unset = single-tenant deployment. */
  orgId?: string;
}

export const EMPTY_AGENT_STATS: AgentActionStats = {
  allowed: 0,
  blocked: 0,
  approvalsRequested: 0,
};

/** Deterministic reputation: blocks cost points, sustained good behavior earns them back. */
export function computeTrustScore(stats: AgentActionStats): number {
  const penalty = stats.blocked * TRUST_PENALTY_PER_BLOCK;
  const recovery = Math.floor(stats.allowed / TRUST_RECOVERY_ALLOWED_ACTIONS);
  const score = TRUST_SCORE_MAX - penalty + recovery;
  return Math.min(TRUST_SCORE_MAX, Math.max(TRUST_SCORE_MIN, score));
}
