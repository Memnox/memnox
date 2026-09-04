import type { DiscoveredAgentKind } from './discovery.constants';

/** A kind, not a session, or the roster is noise by week two. */
export interface DiscoveredAgent {
  id: string;
  kind: DiscoveredAgentKind;
  version?: string;
  /** The files that proved it exists, so a detection can be argued with. */
  configPaths: string[];
  /** Which apps host it: one agent kind can run inside several clients. */
  clients: string[];
  /** Generated locally and never sent; the public half goes up only at enrolment. */
  keypairPath?: string;
  /** The operating-system user, until a person confirms it. Phase 04 makes it an edge. */
  ownerHint: string;
  firstSeen: string;
  lastSeen: string;
}

export interface AgentRef {
  id: string;
  kind: DiscoveredAgentKind;
}

export function agentRefOf(agent: DiscoveredAgent): AgentRef {
  return { id: agent.id, kind: agent.kind };
}
