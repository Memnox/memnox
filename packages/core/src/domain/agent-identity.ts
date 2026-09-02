import type { AgentKind, AgentStatus } from '../constants/agent.constants';
import { READ_ONLY_VERBS, type RiskLevel } from '../constants/risk.constants';

/** Actions split on both "." and "_", the same convention the risk classifier reads. */
const ACTION_SEGMENT_SEPARATOR = /[._]/;

/**
 * Deterministic and verb-based: quarantine has to decide read from write without a model
 * and without a rule set, because the point of it is to hold an agent whose rules may be
 * exactly what is in question. An action naming no read verb is not a read.
 */
export function isReadOnlyAction(action: string): boolean {
  return action
    .toLowerCase()
    .split(ACTION_SEGMENT_SEPARATOR)
    .some((segment) => READ_ONLY_VERBS.includes(segment));
}

export interface AgentActionStats {
  allowed: number;
  withheld: number;
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
  /** Who answers for this agent, §20 — optional and reported, never defaulted. */
  owner?: string;
  /** The team it works for, §20. Scopes it in the organizational graph. */
  team?: string;
  /** What it can reach. Reported, and never a permission of its own. */
  risk?: RiskLevel;
  /** The named level a person granted it. Authority lives here, never in a number. */
  autonomyLevel?: number;
  /** Last credential rotation, when one has happened. */
  rotatedAt?: string;
}

export const EMPTY_AGENT_STATS: AgentActionStats = {
  allowed: 0,
  withheld: 0,
  approvalsRequested: 0,
};
