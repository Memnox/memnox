import type { DiscoveredAgentKind } from './discovery.constants';

/** What every agent id starts with, and the only place it is spelled. */
export const AGENT_ID_PREFIX = 'agt_';

/** The id a detected agent is known by, everywhere, for ever. */
export function agentIdFor(kind: string): string {
  return `${AGENT_ID_PREFIX}${kind}`;
}

/** The id without its prefix, for a sentence a person reads. */
export function agentNameIn(agentId: string): string {
  return agentId.startsWith(AGENT_ID_PREFIX)
    ? agentId.slice(AGENT_ID_PREFIX.length)
    : agentId;
}

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
  /** The operating-system user, until a person confirms it. */
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
