import { describe, expect, it } from 'vitest';
import { agentUpdates, ALERT, alertsFor, describeUpdate } from '../src/discovery/alerts';
import type { EnvironmentChange, EnvironmentSnapshot } from '../src/discovery/snapshot';

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
        detail: 'secret reachable',
      }),
    ]);
    expect(alert?.kind).toBe(ALERT.CREDENTIAL_EXPOSED);
    expect(alert?.headline).toContain('now reachable by an agent');
    expect(alert?.next).toContain('memnox explain');
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
      detail: 'secret no longer reachable',
    });
    expect(alertsFor([narrowed])).toEqual([]);
  });

  it('gives every alert a next step, or it is only noise', () => {
    const alerts = alertsFor([
      change({ subject: 'resource', name: 'k', detail: 'credential' }),
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
