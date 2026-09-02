import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CHANGE_DIRECTION,
  CHANGE_SUBJECT,
  SENSITIVITY,
  TOOL_EFFECT,
} from '../src/discovery.constants';
import {
  compareSnapshots,
  summarizeChanges,
  type EnvironmentSnapshot,
} from '../src/snapshot';
import { NodeSnapshotStore } from '../src/snapshot-store';
import { traceCapability } from '../src/trace';

const SHARED_READ_BITS = 0o077;

function snapshot(overrides: Partial<EnvironmentSnapshot>): EnvironmentSnapshot {
  return {
    takenAt: '2026-01-01T09:00:00.000Z',
    agents: [],
    servers: [],
    resources: [],
    ...overrides,
  };
}

const GITHUB = {
  name: 'github',
  grantedBy: '/home/dev/.claude.json',
  agentIds: ['agt_claude-code'],
  tools: [{ name: 'get_issue', effect: TOOL_EFFECT.READ }],
};

const STRIPE = {
  name: 'stripe',
  grantedBy: '/home/dev/.config/mcp.json',
  agentIds: ['agt_claude-code'],
  tools: [
    { name: 'create_refund', effect: TOOL_EFFECT.WRITE },
    { name: 'delete_customer', effect: TOOL_EFFECT.DESTRUCTIVE },
  ],
};

describe('compareSnapshots', () => {
  it('names an arriving server, what it can do, and the file that granted it', () => {
    const changes = compareSnapshots(
      snapshot({ servers: [GITHUB] }),
      snapshot({ servers: [GITHUB, STRIPE] }),
    );

    expect(changes).toHaveLength(1);
    expect(changes[0]?.name).toBe('stripe');
    expect(changes[0]?.subject).toBe(CHANGE_SUBJECT.SERVER);
    expect(changes[0]?.direction).toBe(CHANGE_DIRECTION.WIDENS);
    expect(changes[0]?.detail).toBe('2 tools · 1 write · 1 destructive');
    expect(changes[0]?.grantedBy).toBe('/home/dev/.config/mcp.json');
  });

  /** A tool arriving on a server that was already there widens authority just as much. */
  it('names a tool that arrived on a server already present', () => {
    const changes = compareSnapshots(
      snapshot({ servers: [GITHUB] }),
      snapshot({
        servers: [
          {
            ...GITHUB,
            tools: [
              ...GITHUB.tools,
              { name: 'delete_branch', effect: TOOL_EFFECT.DESTRUCTIVE },
            ],
          },
        ],
      }),
    );

    expect(changes[0]?.subject).toBe(CHANGE_SUBJECT.TOOL);
    expect(changes[0]?.detail).toContain('delete_branch');
  });

  /**
   * A file nothing could reach yesterday and three agents reach today never shows up
   * as a new path, which is why reach is compared and not just presence.
   */
  it('names a credential that more agents now reach', () => {
    const credential = {
      id: 'res_1',
      kind: 'secret' as const,
      path: '/home/dev/.aws/credentials',
      sensitivity: SENSITIVITY.CRITICAL,
      reachableBy: ['agt_claude-code'],
    };

    const changes = compareSnapshots(
      snapshot({ resources: [credential] }),
      snapshot({
        resources: [{ ...credential, reachableBy: ['agt_claude-code', 'agt_cursor'] }],
      }),
    );

    expect(changes[0]?.direction).toBe(CHANGE_DIRECTION.WIDENS);
    expect(changes[0]?.detail).toBe('1 → 2 agents');
  });

  it('counts both directions, because a list that mixes them helps nobody', () => {
    const changes = compareSnapshots(
      snapshot({ servers: [GITHUB, STRIPE] }),
      snapshot({ servers: [STRIPE] }),
    );

    expect(summarizeChanges(changes)).toEqual({ widens: 0, narrows: 1 });
  });
});

describe('traceCapability', () => {
  it('dates the arrival against the scan that first held it', () => {
    const trace = traceCapability('create_refund', [
      snapshot({ takenAt: '2026-01-01T09:00:00.000Z', servers: [GITHUB] }),
      snapshot({ takenAt: '2026-01-08T09:00:00.000Z', servers: [GITHUB, STRIPE] }),
    ]);

    expect(trace?.server).toBe('stripe');
    expect(trace?.firstSeen).toBe('2026-01-08T09:00:00.000Z');
    expect(trace?.grantedBy).toBe('/home/dev/.config/mcp.json');
  });

  /** "At least this long" is honest; a date read off the oldest kept scan would not be. */
  it('gives no arrival date for something the oldest kept scan already held', () => {
    const trace = traceCapability('get_issue', [
      snapshot({ takenAt: '2026-01-01T09:00:00.000Z', servers: [GITHUB] }),
      snapshot({ takenAt: '2026-01-08T09:00:00.000Z', servers: [GITHUB] }),
    ]);

    expect(trace?.firstSeen).toBeUndefined();
  });

  it('is null for a tool this machine does not hold', () => {
    expect(
      traceCapability('deploy_service', [snapshot({ servers: [GITHUB] })]),
    ).toBeNull();
  });
});

describe('NodeSnapshotStore', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'memnox-snapshots-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('reads back the newest scan, and nothing at all on a first run', async () => {
    const store = new NodeSnapshotStore(root);
    expect(await store.latest()).toBeNull();

    await store.save(snapshot({ takenAt: '2026-01-01T09:00:00.000Z' }));
    await store.save(snapshot({ takenAt: '2026-01-08T09:00:00.000Z' }));

    expect((await store.latest())?.takenAt).toBe('2026-01-08T09:00:00.000Z');
  });

  /** "--since yesterday" has to land on the scan before it, never on today's own. */
  it('answers with the newest scan at or before a moment', async () => {
    const store = new NodeSnapshotStore(root);
    await store.save(snapshot({ takenAt: '2026-01-01T09:00:00.000Z' }));
    await store.save(snapshot({ takenAt: '2026-01-08T09:00:00.000Z' }));

    expect((await store.latest('2026-01-05T00:00:00.000Z'))?.takenAt).toBe(
      '2026-01-01T09:00:00.000Z',
    );
  });

  it('drops the oldest once the history is full', async () => {
    const store = new NodeSnapshotStore(root, 2);
    for (const day of ['01', '02', '03']) {
      await store.save(snapshot({ takenAt: `2026-01-${day}T09:00:00.000Z` }));
    }

    const kept = await store.history();
    expect(kept.map((each) => each.takenAt)).toEqual([
      '2026-01-02T09:00:00.000Z',
      '2026-01-03T09:00:00.000Z',
    ]);
  });

  /** A snapshot names every path an agent on this machine can reach. */
  it('writes owner-only', async () => {
    const store = new NodeSnapshotStore(root);
    await store.save(snapshot({ takenAt: '2026-01-01T09:00:00.000Z' }));

    const info = await stat(join(root, 'snapshots', '2026-01-01T09-00-00.000Z.json'));
    expect(info.mode & SHARED_READ_BITS).toBe(0);
  });
});
