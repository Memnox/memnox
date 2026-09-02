import { describe, expect, it } from 'vitest';
import { concurrentWork, overlappingWork, type WorkObservation } from '../src/collision';

const NOW = '2026-08-31T12:00:00.000Z';

function touch(overrides: Partial<WorkObservation>): WorkObservation {
  return {
    agentId: 'agt_1',
    agentName: 'claude-code',
    target: 'src/payments.ts',
    at: '2026-08-31T11:50:00.000Z',
    writing: true,
    ...overrides,
  };
}

describe('concurrentWork', () => {
  it('names two agents inside one file inside the window', () => {
    const found = concurrentWork(
      [
        touch({}),
        touch({ agentId: 'agt_2', agentName: 'codex', at: '2026-08-31T11:56:00.000Z' }),
      ],
      { now: NOW, windowMinutes: 30 },
    );

    expect(found).toHaveLength(1);
    expect(found[0]?.target).toBe('src/payments.ts');
    expect(found[0]?.agents.map((agent) => agent.agentName)).toEqual([
      'claude-code',
      'codex',
    ]);
  });

  /** Two readers in one file is a normal Tuesday, and reporting it trains people to ignore this. */
  it('says nothing when neither agent wrote', () => {
    const found = concurrentWork(
      [
        touch({ writing: false }),
        touch({ agentId: 'agt_2', agentName: 'codex', writing: false }),
      ],
      { now: NOW, windowMinutes: 30 },
    );

    expect(found).toEqual([]);
  });

  it('leaves out a touch older than the window', () => {
    const found = concurrentWork(
      [
        touch({ at: '2026-08-31T09:00:00.000Z' }),
        touch({ agentId: 'agt_2', agentName: 'codex' }),
      ],
      { now: NOW, windowMinutes: 30 },
    );

    expect(found).toEqual([]);
  });

  it('does not report one agent colliding with itself', () => {
    const found = concurrentWork([touch({}), touch({ at: '2026-08-31T11:55:00.000Z' })], {
      now: NOW,
      windowMinutes: 30,
    });

    expect(found).toEqual([]);
  });
});

describe('overlappingWork', () => {
  const shared = [
    touch({
      target: 'src/auth/tokens.ts',
      at: '2026-08-28T09:00:00.000Z',
      branch: 'oauth-refresh',
    }),
    touch({
      target: 'src/auth/session.ts',
      at: '2026-08-28T09:05:00.000Z',
      branch: 'oauth-refresh',
    }),
    touch({
      agentId: 'agt_2',
      agentName: 'codex',
      target: 'src/auth/tokens.ts',
      at: '2026-08-31T09:00:00.000Z',
      branch: 'token-rotation',
    }),
    touch({
      agentId: 'agt_2',
      agentName: 'codex',
      target: 'src/auth/session.ts',
      at: '2026-08-31T09:05:00.000Z',
      branch: 'token-rotation',
    }),
  ];

  it('pairs two agents writing the same files on different branches', () => {
    const found = overlappingWork(shared, { now: NOW, windowDays: 7 });

    expect(found).toHaveLength(1);
    expect(found[0]?.sharedTargets).toEqual([
      'src/auth/session.ts',
      'src/auth/tokens.ts',
    ]);
    expect(found[0]?.agents.map((agent) => agent.branch)).toEqual([
      'oauth-refresh',
      'token-rotation',
    ]);
    expect(found[0]?.since).toBe('2026-08-28T09:00:00.000Z');
  });

  /** One shared file is a coincidence, and a report full of them is a report nobody reads. */
  it('needs more than one shared file', () => {
    const found = overlappingWork(shared.slice(0, 3), { now: NOW, windowDays: 7 });

    expect(found).toEqual([]);
  });

  it('ignores reads: wanting the file is not building the same thing', () => {
    const found = overlappingWork(
      shared.map((each) => ({ ...each, writing: false })),
      { now: NOW, windowDays: 7 },
    );

    expect(found).toEqual([]);
  });
});
