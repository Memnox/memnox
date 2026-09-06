import type { EnvironmentSnapshot } from '@memnox/core';

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

/** Names and structure only, exactly as the snapshot itself is bound to. */
export function censusFrom(snapshot: EnvironmentSnapshot): Record<string, unknown>[] {
  const at = Date.parse(snapshot.takenAt);
  const rows: Record<string, unknown>[] = [];

  for (const agent of snapshot.agents) {
    rows.push({
      kind: AGENT_REPORTED,
      /* One row per agent per scan: the same agent seen again has to move its
         last-seen, and a key that did not change would be read as a redelivery
         and dropped. */
      dedupKey: `agent:${agent.id}@${snapshot.takenAt}`,
      subjectId: agent.id,
      actorType: 'automation',
      occurredAt: at,
      payload: {
        agentId: agent.id,
        kind: agent.kind,
        ...(agent.version === undefined ? {} : { version: agent.version }),
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
