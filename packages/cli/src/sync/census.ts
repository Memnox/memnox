import { createHash } from 'node:crypto';
import type { EnvironmentSnapshot } from '@memnox/core';
import { displayName, type AgentNames } from '../agents/names';
import type { Declined } from '../agents/declined';

/**
 * What this machine can do, sent so the console can answer it.
 *
 * The ledger answers what an agent *did*. Nothing has ever carried what it *can*
 * do, and the control plane is built to receive exactly that — `agent.reported`
 * names an agent that exists here, `agent.reach.reported` names something it can
 * touch and has not. Both projections were in place and both were empty for every
 * workspace, because a scan stayed on the laptop that ran it.
 *
 * Derived from a kept scan rather than by taking one: a scan spawns every MCP
 * server it finds and takes seconds, and doing that on a sync loop would make the
 * quietest thing this product does the most expensive.
 */
const AGENT_REPORTED = 'agent.reported';
const REACH_REPORTED = 'agent.reach.reported';

/**
 * What somebody on this machine decided about the agents on it.
 *
 * A scan says what is here and this says what was done about it, and the two
 * are sent together because a row carrying only the first is a question the
 * console asks again after somebody has already answered it. Claude Desktop
 * declined in a guided run reached the workspace looking exactly like an agent
 * nobody had ever been offered, under the id rather than the name it was
 * offered by.
 *
 * Neither field is authority. A label is what the row is printed as and the id
 * stays what it is keyed on; a decline says a person here said no, which is a
 * fact about this machine rather than a claim about the agent.
 */
export interface CensusDecisions {
  /** What a person on this machine calls each agent. */
  names: AgentNames;
  /** The agents somebody here was offered and said no to. */
  declined: Declined;
}

/** Names and structure only, exactly as the snapshot itself is bound to. */
export function censusFrom(
  snapshot: EnvironmentSnapshot,
  /* Required rather than defaulted: a caller that forgot it would send a
     census with every agent unnamed and every answer lost, and would look
     exactly like one that had nothing to say. */
  decided: CensusDecisions,
): Record<string, unknown>[] {
  const at = Date.parse(snapshot.takenAt);
  const rows: Record<string, unknown>[] = [];

  for (const agent of snapshot.agents) {
    const label = displayName(decided.names, agent);
    const declinedAt = decided.declined[agent.id];
    rows.push({
      kind: AGENT_REPORTED,
      /* One row per agent per scan: the same agent seen again has to move its
         last-seen, and a key that did not change would be read as a redelivery
         and dropped. The decision is in the key for the same reason, one step
         further on: renaming an agent or saying no to it changes nothing about
         the scan, so a key built from the scan alone would carry the new
         answer under the old key and have it dropped as a resend. */
      dedupKey: `agent:${agent.id}@${snapshot.takenAt}:${decisionOf(label, declinedAt)}`,
      subjectId: agent.id,
      actorType: 'automation',
      occurredAt: at,
      payload: {
        agentId: agent.id,
        kind: agent.kind,
        ...(agent.version === undefined ? {} : { version: agent.version }),
        label,
        /* Sent as an instant rather than a flag, because "left alone in March"
           and "left alone this morning" are different answers to whether the
           question is worth putting back in front of somebody. Absent where
           nobody has been asked, which is not the same as a no. */
        ...(declinedAt === undefined ? {} : { declinedAt: Date.parse(declinedAt) }),
      },
    });
  }

  /* A tool an agent can call, and a path it can read: both are reach, and the
     control plane keys them the same way. The chain is carried so the console can
     say how it is reached rather than only that it is. */
  for (const server of snapshot.servers) {
    for (const agentId of server.agentIds) {
      for (const tool of server.tools) {
        rows.push(
          reach(
            snapshot,
            at,
            agentId,
            `mcp:${server.name}/${tool.name}`,
            [tool.effect],
            [agentId, server.name, tool.name],
          ),
        );
      }
    }
  }

  for (const resource of snapshot.resources) {
    for (const agentId of resource.reachableBy) {
      rows.push(
        reach(
          snapshot,
          at,
          agentId,
          resource.path ?? resource.id,
          [resource.kind, resource.sensitivity],
          [agentId, resource.id],
        ),
      );
    }
  }

  return rows;
}

/**
 * Everything about this machine's own answers, in one digest.
 *
 * `pushCensus` holds it beside the scan it last sent, so a name typed or a no
 * given after that scan is still sent without taking a second scan to carry it.
 */
export function decisionDigest(decided: CensusDecisions): string {
  return short(
    JSON.stringify([
      Object.entries(decided.names).sort(),
      Object.entries(decided.declined).sort(),
    ]),
  );
}

/** Short enough to sit in a key, long enough that two answers do not collide. */
function decisionOf(label: string, declinedAt: string | undefined): string {
  return short(`${label}\n${declinedAt ?? ''}`);
}

function short(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 12);
}

function reach(
  snapshot: EnvironmentSnapshot,
  at: number,
  agentId: string,
  resourceRef: string,
  classes: readonly string[],
  path: readonly string[],
): Record<string, unknown> {
  return {
    kind: REACH_REPORTED,
    dedupKey: `reach:${agentId}:${resourceRef}@${snapshot.takenAt}`,
    subjectId: agentId,
    actorType: 'automation',
    occurredAt: at,
    payload: { agentId, resourceRef, classes: [...classes], path: [...path] },
  };
}
