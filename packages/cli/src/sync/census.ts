import { createHash } from 'node:crypto';

import { TOOL_EFFECT, type EnvironmentSnapshot } from '@memnox/core';

import { displayName, type AgentNames } from '../agents/names';
import type { Declined } from '../agents/declined';
import { MANAGED_SERVER } from '../agents/managed-shape';
import { CLOUD_EVENT, eventOf, type CloudEvent } from './cloud-event';

/**
 * What this machine can do, sent so the console can answer it: which agents exist here
 * and what each can touch. Derived from a kept scan, because taking one spawns every
 * MCP server it finds and takes seconds.
 */

/**
 * What somebody on this machine decided about its agents, sent with the scan so the
 * console does not ask again about an agent somebody already declined. Neither is authority.
 */
export interface CensusDecisions {
  /** What a person on this machine calls each agent. */
  names: AgentNames;
  /** The agents somebody here was offered and said no to. */
  declined: Declined;
}

/** Something an agent can touch and has not, as one reach row. */
interface ReachInput {
  snapshot: EnvironmentSnapshot;
  agentId: string;
  resourceRef: string;
  classes: readonly string[];
  /** The chain it is reached through, so the console can say how. */
  path: readonly string[];
}

/**
 * How much of the hash a dedup key carries. Longer than `shortDigest`, because a
 * collision on the wire would silently drop one machine's answer for another's.
 */
const KEY_DIGEST_LENGTH = 12;

/** Names and structure only, exactly as the snapshot itself is bound to. */
export function censusFrom(
  snapshot: EnvironmentSnapshot,
  // Required, because a caller that forgot it would send every agent unnamed.
  decided: CensusDecisions,
): CloudEvent[] {
  return [
    ...snapshot.agents.map((agent) => agentRowOf(snapshot, agent, decided)),
    ...toolReachOf(snapshot),
    ...resourceReachOf(snapshot),
    ...serverRowsOf(snapshot),
  ];
}

/** A tool that changes something, which is the count a reviewer weighs a server by. */
const WRITING_EFFECTS: readonly string[] = [TOOL_EFFECT.WRITE, TOOL_EFFECT.DESTRUCTIVE];

/**
 * One row per server, so the console can list every server the team runs and say which
 * are governed. Names, counts and a transport only: never a launch line, an argument, a
 * URL or an environment value, any of which can carry a credential.
 */
function serverRowsOf(snapshot: EnvironmentSnapshot): CloudEvent[] {
  return snapshot.servers.map((server) => {
    // The entry onboarding writes is Memnox itself, so it is governed by construction.
    const governed = server.wrapped === true || server.name === MANAGED_SERVER;
    return eventOf({
      kind: CLOUD_EVENT.MCP_SERVER_REPORTED,
      dedupKey: `mcp-server:${server.name}@${snapshot.takenAt}`,
      subjectId: server.name,
      occurredAt: Date.parse(snapshot.takenAt),
      payload: {
        server: server.name,
        agentIds: [...server.agentIds],
        governed,
        // Unknown rather than a guess, on a snapshot kept before this was recorded.
        ...(server.transport === undefined ? {} : { transport: server.transport }),
        toolCount: server.tools.length,
        writeToolCount: server.tools.filter((tool) =>
          WRITING_EFFECTS.includes(tool.effect),
        ).length,
      },
    });
  });
}

/**
 * Everything about this machine's own answers, in one digest, held beside the last scan
 * so a name or a decline given afterwards is sent without taking a second scan.
 */
export function decisionDigest(decided: CensusDecisions): string {
  return short(
    JSON.stringify([
      Object.entries(decided.names).sort(),
      Object.entries(decided.declined).sort(),
    ]),
  );
}

function agentRowOf(
  snapshot: EnvironmentSnapshot,
  agent: EnvironmentSnapshot['agents'][number],
  decided: CensusDecisions,
): CloudEvent {
  const label = displayName(decided.names, agent);
  const declinedAt = decided.declined[agent.id];
  return eventOf({
    kind: CLOUD_EVENT.AGENT_REPORTED,
    // The decision is in the key, so a rename is not dropped as a resend of the scan.
    dedupKey: `agent:${agent.id}@${snapshot.takenAt}:${decisionOf(label, declinedAt)}`,
    subjectId: agent.id,
    occurredAt: Date.parse(snapshot.takenAt),
    payload: {
      agentId: agent.id,
      kind: agent.kind,
      ...(agent.version === undefined ? {} : { version: agent.version }),
      label,
      // Kinds only, never the file that proved one, so the console can say what it can do.
      surfaces: [...new Set(agent.surfaces.map((surface) => surface.kind))].sort(),
      // An instant rather than a flag, because how long ago decides whether to ask again.
      ...(declinedAt === undefined ? {} : { declinedAt: Date.parse(declinedAt) }),
    },
  });
}

function toolReachOf(snapshot: EnvironmentSnapshot): CloudEvent[] {
  return snapshot.servers.flatMap((server) =>
    server.agentIds.flatMap((agentId) =>
      server.tools.map((tool) =>
        reach({
          snapshot,
          agentId,
          resourceRef: `mcp:${server.name}/${tool.name}`,
          classes: [tool.effect],
          path: [agentId, server.name, tool.name],
        }),
      ),
    ),
  );
}

function resourceReachOf(snapshot: EnvironmentSnapshot): CloudEvent[] {
  return snapshot.resources.flatMap((resource) =>
    resource.reachableBy.map((agentId) =>
      reach({
        snapshot,
        agentId,
        resourceRef: resource.path ?? resource.id,
        classes: [resource.kind, resource.sensitivity],
        path: [agentId, resource.id],
      }),
    ),
  );
}

function short(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, KEY_DIGEST_LENGTH);
}

/** Short enough to sit in a key, long enough that two answers do not collide. */
function decisionOf(label: string, declinedAt: string | undefined): string {
  return short(`${label}\n${declinedAt ?? ''}`);
}

function reach(input: ReachInput): CloudEvent {
  const { snapshot, agentId, resourceRef } = input;
  return eventOf({
    kind: CLOUD_EVENT.REACH_REPORTED,
    dedupKey: `reach:${agentId}:${resourceRef}@${snapshot.takenAt}`,
    subjectId: agentId,
    occurredAt: Date.parse(snapshot.takenAt),
    payload: { agentId, resourceRef, classes: [...input.classes], path: [...input.path] },
  });
}
