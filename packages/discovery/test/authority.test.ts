import { describe, expect, it } from 'vitest';
import { SURFACE_KIND, TOOL_EFFECT } from '../src/discovery.constants';
import { authorityTrend } from '../src/authority';
import { compareSnapshots, type EnvironmentSnapshot } from '../src/snapshot';

function snapshot(
  takenAt: string,
  overrides: Partial<EnvironmentSnapshot> = {},
): EnvironmentSnapshot {
  return { takenAt, agents: [], servers: [], resources: [], ...overrides };
}

const server = (
  name: string,
  writes: number,
  grantedBy = '/home/dev/.config/mcp.json',
) => ({
  name,
  grantedBy,
  agentIds: ['agt_claude-code'],
  tools: Array.from({ length: writes }, (_, index) => ({
    name: `create_${index}`,
    effect: TOOL_EFFECT.WRITE,
  })),
});

describe('authority measured over time', () => {
  it('says how much external write capability arrived, and off which base', () => {
    const trend = authorityTrend([
      snapshot('2026-01-01T09:00:00.000Z', { servers: [server('github', 6)] }),
      snapshot('2026-02-01T09:00:00.000Z', {
        servers: [server('github', 6), server('stripe', 6)],
      }),
    ]);

    expect(trend.points.map((point) => point.externalWrite)).toEqual([6, 12]);
    expect(trend.added).toBe(6);
    expect(trend.percent).toBe(100);
  });

  it('publishes no percentage off a base of nothing', () => {
    const trend = authorityTrend([
      snapshot('2026-01-01T09:00:00.000Z'),
      snapshot('2026-02-01T09:00:00.000Z', { servers: [server('stripe', 5)] }),
    ]);

    expect(trend.added).toBe(5);
    expect(trend.percent).toBeUndefined();
  });

  it('attaches each increase to the server that caused it, largest first', () => {
    const trend = authorityTrend([
      snapshot('2026-01-01T09:00:00.000Z'),
      snapshot('2026-04-01T09:00:00.000Z', {
        servers: [server('aws', 11, '/home/dev/.claude.json'), server('stripe', 14)],
      }),
    ]);

    expect(trend.contributors).toEqual([
      { server: 'stripe', added: 14, grantedBy: '/home/dev/.config/mcp.json' },
      { server: 'aws', added: 11, grantedBy: '/home/dev/.claude.json' },
    ]);
  });

  it('reports no movement from a single scan', () => {
    const trend = authorityTrend([
      snapshot('2026-01-01T09:00:00.000Z', { servers: [server('github', 6)] }),
    ]);

    expect(trend.added).toBe(0);
    expect(trend.contributors).toEqual([]);
  });
});

describe('an update is named as the cause of what moved with it', () => {
  const agent = (version: string, surfaces: string[]) => ({
    id: 'agt_claude-code',
    kind: 'claude-code',
    version,
    surfaces: surfaces.map((kind) => ({
      kind: kind as (typeof SURFACE_KIND)[keyof typeof SURFACE_KIND],
      detectedFrom: '/home/dev/.claude.json',
    })),
  });

  it('names the version that moved beside the surface it added', () => {
    const changes = compareSnapshots(
      snapshot('2026-01-01T09:00:00.000Z', { agents: [agent('2.4.1', ['shell'])] }),
      snapshot('2026-01-02T09:00:00.000Z', {
        agents: [agent('2.5.0', ['shell', 'browser'])],
      }),
    );

    expect(changes[0]?.cause).toBe('updated 2.4.1 → 2.5.0');
  });

  it('leaves the cause off when the agent did not move', () => {
    const changes = compareSnapshots(
      snapshot('2026-01-01T09:00:00.000Z', { agents: [agent('2.5.0', ['shell'])] }),
      snapshot('2026-01-02T09:00:00.000Z', {
        agents: [agent('2.5.0', ['shell', 'browser'])],
      }),
    );

    expect(changes[0]?.cause).toBeUndefined();
  });

  it('carries the cause onto the tools the update brought with it', () => {
    const changes = compareSnapshots(
      snapshot('2026-01-01T09:00:00.000Z', {
        agents: [agent('2.4.1', ['mcp'])],
        servers: [server('github', 1)],
      }),
      snapshot('2026-01-02T09:00:00.000Z', {
        agents: [agent('2.5.0', ['mcp'])],
        servers: [server('github', 3)],
      }),
    );

    expect(changes[0]?.cause).toBe('updated 2.4.1 → 2.5.0');
  });
});
