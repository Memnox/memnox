import { describe, expect, it } from 'vitest';
import {
  ACTOR_TYPE,
  agentReachOf,
  DECISION_EFFECT,
  describeReach,
  DORMANT_AFTER_DAYS,
  dormantAgents,
  ENFORCEMENT_MODE,
  EVENT_SCHEMA_VERSION,
  EVENT_SURFACE,
  SENSITIVITY,
  RESOURCE_KIND,
  TOOL_CLASS,
  TOOL_EFFECT,
  type EnvironmentSnapshot,
  type MemnoxEvent,
} from '../src/index';

/**
 * An agent installed in spring and never used again still holds every key it was given.
 * Nothing on the machine said so, because every screen counted what agents did.
 */

const NOW = '2026-09-24T10:00:00.000Z';
const DAY_MS = 24 * 60 * 60 * 1_000;

function daysAgo(days: number): string {
  return new Date(Date.parse(NOW) - days * DAY_MS).toISOString();
}

const SNAPSHOT: EnvironmentSnapshot = {
  takenAt: NOW,
  agents: [
    { id: 'agt_cursor', kind: 'cursor', surfaces: [] },
    { id: 'agt_codex-cli', kind: 'codex-cli', surfaces: [] },
  ],
  servers: [
    {
      name: 'github',
      grantedBy: '/home/dev/.cursor/mcp.json',
      agentIds: ['agt_cursor'],
      tools: [
        { name: 'merge_pull_request', effect: TOOL_EFFECT.WRITE },
        { name: 'get_issue', effect: TOOL_EFFECT.READ },
      ],
    },
  ],
  resources: [
    {
      id: 'res_aws',
      kind: RESOURCE_KIND.SECRET,
      path: '/home/dev/.aws/credentials',
      sensitivity: SENSITIVITY.CRITICAL,
      reachableBy: ['agt_cursor'],
    },
  ],
};

const OLD = { agt_cursor: daysAgo(90), 'agt_codex-cli': daysAgo(90) };

function work(agent: string, at: string): MemnoxEvent {
  return {
    id: `evt_${agent}_${at}`,
    schemaVersion: EVENT_SCHEMA_VERSION,
    at,
    sessionId: 'ses_1',
    agent,
    actorType: ACTOR_TYPE.AGENT,
    surface: EVENT_SURFACE.MCP,
    operation: 'github.get_issue',
    class: TOOL_CLASS.READ,
    effect: DECISION_EFFECT.ALLOW,
    mode: ENFORCEMENT_MODE.OBSERVE,
    reason: 'allowed',
  };
}

describe('dormant agents', () => {
  it('finds an agent silent for the whole window that still holds reach', () => {
    const dormant = dormantAgents({
      snapshot: SNAPSHOT,
      events: [],
      knownSince: OLD,
      now: NOW,
    });

    expect(dormant.map((agent) => agent.agentId)).toEqual(['agt_cursor']);
    expect(describeReach(dormant[0]!.reach)).toBe(
      '1 server with write tools (github), 1 credential',
    );
  });

  it('leaves out an agent that holds nothing, however quiet', () => {
    expect(agentReachOf(SNAPSHOT, 'agt_codex-cli')).toEqual({
      writeServers: [],
      credentials: 0,
      hooks: [],
    });
  });

  it('counts work inside the window, by id, kind, a chosen name or a proxied server', () => {
    const inside = daysAgo(DORMANT_AFTER_DAYS - 1);
    for (const agent of ['agt_cursor', 'cursor', 'Backend Coder', 'mcp:github']) {
      const dormant = dormantAgents({
        snapshot: SNAPSHOT,
        events: [work(agent, inside)],
        knownSince: OLD,
        now: NOW,
        aliases: { agt_cursor: ['backend coder'] },
      });
      expect(dormant, agent).toEqual([]);
    }
  });

  it('does not count work from before the window', () => {
    const dormant = dormantAgents({
      snapshot: SNAPSHOT,
      events: [work('cursor', daysAgo(DORMANT_AFTER_DAYS + 1))],
      knownSince: OLD,
      now: NOW,
    });

    expect(dormant).toHaveLength(1);
  });

  it('never calls an agent dormant before it has been known for the whole window', () => {
    const tooRecent: Record<string, string>[] = [
      {},
      { agt_cursor: daysAgo(DORMANT_AFTER_DAYS - 1) },
    ];
    for (const knownSince of tooRecent) {
      expect(
        dormantAgents({ snapshot: SNAPSHOT, events: [], knownSince, now: NOW }),
      ).toEqual([]);
    }
    expect(
      dormantAgents({
        snapshot: SNAPSHOT,
        events: [],
        knownSince: { agt_cursor: daysAgo(DORMANT_AFTER_DAYS) },
        now: NOW,
      }),
    ).toHaveLength(1);
  });
});
