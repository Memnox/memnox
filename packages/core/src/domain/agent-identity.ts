import type { AgentKind, AgentStatus } from '../constants/agent.constants';
import type { RiskLevel } from '../constants/risk.constants';

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
  /** Owning org/workspace; unset = single-tenant deployment. */
  orgId?: string;
}

export const EMPTY_AGENT_STATS: AgentActionStats = {
  allowed: 0,
  withheld: 0,
  approvalsRequested: 0,
};
