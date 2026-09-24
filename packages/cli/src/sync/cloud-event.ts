import { ACTOR_TYPE, type ActorType } from '@memnox/core';

/**
 * The one envelope every row sent to the control plane's ingest door travels in, so the
 * census, the findings, the skills and the actions agree on its shape by construction.
 */

/** The kinds the control plane's projections read, spelled in one place. */
export const CLOUD_EVENT = {
  ACTION_RECORDED: 'agent.action.recorded',
  SESSION_STARTED: 'agent.session.started',
  APPROVAL_REQUESTED: 'approval.requested',
  APPROVAL_RESOLVED: 'approval.resolved',
  AGENT_REPORTED: 'agent.reported',
  REACH_REPORTED: 'agent.reach.reported',
  /** One MCP server as this machine configures it: who launches it and whether it is governed. */
  MCP_SERVER_REPORTED: 'mcp.server.reported',
  FINDING_RAISED: 'finding.raised',
  /** A rule a person decided here; the control plane only ever proposes it to the team. */
  RULE_DECIDED_LOCALLY: 'policy.decided_locally',
  /** Somebody ran `memnox stop` here: a report the team sees, never a mode it set. */
  PROTECTION_STOPPED: 'machine.protection.stopped',
  /** Protection back on, by `memnox start` or by the time a stop was given running out. */
  PROTECTION_STARTED: 'machine.protection.started',
} as const;

export type CloudEventKind = (typeof CLOUD_EVENT)[keyof typeof CLOUD_EVENT];

export interface CloudEvent {
  kind: CloudEventKind;
  /** Stable across a resend, which is what lets the control plane deduplicate. */
  dedupKey: string;
  subjectId: string;
  actorType: ActorType;
  occurredAt: number;
  agentSessionId?: string;
  payload: Record<string, unknown>;
}

/** A machine reporting on itself is automation unless an actor is named. */
export type CloudEventInput = Omit<CloudEvent, 'actorType'> & { actorType?: ActorType };

export function eventOf(input: CloudEventInput): CloudEvent {
  return {
    kind: input.kind,
    dedupKey: input.dedupKey,
    subjectId: input.subjectId,
    actorType: input.actorType ?? ACTOR_TYPE.AUTOMATION,
    occurredAt: input.occurredAt,
    ...(input.agentSessionId === undefined
      ? {}
      : { agentSessionId: input.agentSessionId }),
    payload: input.payload,
  };
}

/** The control plane refuses more rows than this in one post, and says so in its own words. */
export const MAX_POST = 500;
