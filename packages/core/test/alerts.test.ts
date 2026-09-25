import { describe, expect, it } from 'vitest';
import { agentUpdates, ALERT, alertsFor, describeUpdate } from '../src/discovery/alerts';
import type { EnvironmentSnapshot } from '../src/discovery/snapshot';
import {
  compareSnapshots,
  type EnvironmentChange,
} from '../src/discovery/snapshot-changes';

const change = (over: Partial<EnvironmentChange>): EnvironmentChange =>
  ({
    subject: 'tool',
    name: 'x',
    direction: 'widens',
    detail: '',
    ...over,
  }) as EnvironmentChange;

describe('what is worth interrupting somebody for', () => {
  it('raises a credential that became reachable, and says what to run next', () => {
    const [alert] = alertsFor([
      change({
        subject: 'resource',
        name: 'AWS_SECRET_ACCESS_KEY',
        detail: 'readable, 1 agent',
        sensitivity: 'critical',
      }),
    ]);
    expect(alert?.kind).toBe(ALERT.CREDENTIAL_EXPOSED);
    expect(alert?.headline).toContain('now reachable by an agent');
    expect(alert?.next).toContain('memnox explain');
  });

  it('stays quiet about an ordinary file, whatever its detail says', () => {
    const ordinary = change({
      subject: 'resource',
      name: 'notes/credential-rotation.md',
      detail: 'credential',
      sensitivity: 'ordinary',
    });
    expect(alertsFor([ordinary])).toEqual([]);
  });

  it('raises a credential the real comparison reports, not only a hand-built one', () => {
    const resource = {
      id: 'res_aws',
      kind: 'secret',
      path: '~/.aws/credentials',
      sensitivity: 'critical',
    } as const;
    const before = {
      takenAt: 't0',
      agents: [],
      servers: [],
      resources: [{ ...resource, reachableBy: [] }],
    } as EnvironmentSnapshot;
    const after = {
      ...before,
      takenAt: 't1',
      resources: [{ ...resource, reachableBy: ['agt_claude-code'] }],
    } as EnvironmentSnapshot;
    const kinds = alertsFor(compareSnapshots(before, after)).map((alert) => alert.kind);
    expect(kinds).toContain(ALERT.CREDENTIAL_EXPOSED);
  });

  it('raises a new server with the command that reviews it', () => {
    const [alert] = alertsFor([
      change({ subject: 'server', name: 'stripe', detail: 'added' }),
    ]);
    expect(alert?.kind).toBe(ALERT.NEW_SERVER);
    expect(alert?.next).toBe('memnox scan --mcp stripe');
  });

  it('raises a new write tool but stays quiet about a new read tool', () => {
    expect(alertsFor([change({ name: 'create_pr', detail: 'write tool' })])).toHaveLength(
      1,
    );
    expect(alertsFor([change({ name: 'get_issue', detail: 'read tool' })])).toHaveLength(
      0,
    );
  });

  it('never fires on a narrowing, because losing a permission is not an incident', () => {
    const narrowed = change({
      subject: 'resource',
      name: 'AWS_SECRET_ACCESS_KEY',
      direction: 'narrows',
      detail: '1 → 0 agents',
      sensitivity: 'critical',
    });
    expect(alertsFor([narrowed])).toEqual([]);
  });

  it('gives every alert a next step, or it is only noise', () => {
    const alerts = alertsFor([
      change({
        subject: 'resource',
        name: 'k',
        detail: 'readable',
        sensitivity: 'sensitive',
      }),
      change({ subject: 'server', name: 's', detail: 'added' }),
      change({ name: 't', detail: 'destructive tool' }),
    ]);
    expect(alerts).toHaveLength(3);
    for (const alert of alerts) expect(alert.next.length).toBeGreaterThan(0);
  });
});

function snapshot(version: string, tools: number): EnvironmentSnapshot {
  return {
    takenAt: '2026-09-05T10:00:00.000Z',
    agents: [{ id: 'agt_1', kind: 'claude-code', version, surfaces: [] }],
    servers: [
      {
        name: 'github',
        grantedBy: '.claude.json',
        agentIds: ['agt_1'],
        tools: Array.from({ length: tools }, (_unused, n) => ({
          name: `tool_${n}`,
          effect: 'write',
        })),
      },
    ],
    resources: [],
  } as unknown as EnvironmentSnapshot;
}

describe('an agent that updated itself', () => {
  it('reports the before and after count, because nobody granted the difference', () => {
    const [update] = agentUpdates(snapshot('1.0.0', 12), snapshot('1.1.0', 17));

    expect(update).toMatchObject({
      agent: 'claude-code',
      before: '1.0.0',
      after: '1.1.0',
      capabilitiesBefore: 12,
      capabilitiesAfter: 17,
    });
    expect(describeUpdate(update as never)).toContain('12 → 17');
    expect(describeUpdate(update as never)).toContain('5 more');
  });

  it('says so plainly when an update took capabilities away', () => {
    const [update] = agentUpdates(snapshot('1.1.0', 17), snapshot('1.2.0', 12));
    expect(describeUpdate(update as never)).toContain('5 fewer');
  });

  it('stays quiet when the version did not move', () => {
    expect(agentUpdates(snapshot('1.0.0', 12), snapshot('1.0.0', 12))).toEqual([]);
  });

  it('names an update that changed nothing, rather than hiding it', () => {
    const [update] = agentUpdates(snapshot('1.0.0', 12), snapshot('1.1.0', 12));
    expect(describeUpdate(update as never)).toContain('same capabilities');
  });
});

describe('a server that went away', () => {
  it('is an alert, because what relied on it now fails', () => {
    const alerts = alertsFor([
      {
        subject: 'server',
        name: 'railway',
        direction: 'narrows',
        detail: 'removed',
      } as never,
    ]);
    expect(alerts.map((alert) => alert.kind)).toEqual(['server-gone']);
  });
});
