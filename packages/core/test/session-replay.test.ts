import { describe, expect, it } from 'vitest';
import type { MemnoxEvent } from '../src/event/event';
import type { PendingApproval } from '../src/gate/pending';
import type { Milestone } from '../src/recovery/milestone';
import type { SessionPause } from '../src/session/pause';
import {
  buildReplay,
  LEAD_UP_STEPS,
  REPLAY_END,
  REPLAY_STEP,
} from '../src/session/session-replay';

function event(id: string, minute: number, over: Partial<MemnoxEvent> = {}): MemnoxEvent {
  return {
    id,
    schemaVersion: 1,
    at: `2026-09-24T10:${String(minute).padStart(2, '0')}:00.000Z`,
    sessionId: 'ses_1',
    agent: 'claude-code',
    actorType: 'agent',
    surface: 'shell',
    operation: 'npm.test',
    class: 'read',
    effect: 'allow',
    mode: 'enforce',
    reason: 'no rule matched',
    ...over,
  };
}

const milestone: Milestone = {
  id: 'mst_1',
  commit: 'abc',
  takenAt: '2026-09-24T09:59:30.000Z',
  reason: 'first-write',
  sessionId: 'ses_1',
  agent: 'claude-code',
  note: 'before claude-code first wrote here',
  files: 12,
};

describe('a session replayed', () => {
  it('merges every record into the order it happened in', () => {
    const pending: PendingApproval = {
      id: 'apr_1',
      request: {
        sessionId: 'ses_1',
        agent: 'claude-code',
        operation: 'git.push',
        fingerprint: 'f',
        reason: 'pushing asks',
      },
      askedAt: '2026-09-24T10:02:30.000Z',
      expiresAt: '2026-09-24T11:00:00.000Z',
    };
    const replay = buildReplay({
      sessionId: 'ses_1',
      events: [event('a', 1), event('b', 3), event('other', 2, { sessionId: 'ses_2' })],
      pending: [pending],
      milestones: [milestone],
    });

    expect(replay.steps.map((step) => step.kind)).toEqual([
      REPLAY_STEP.MILESTONE,
      REPLAY_STEP.ACTION,
      REPLAY_STEP.HOLD,
      REPLAY_STEP.ACTION,
    ]);
    expect(replay.steps[2]?.summary).toContain('waiting for an answer');
    expect(replay.end).toBe(REPLAY_END.CLEAN);
    expect(replay.agent).toBe('claude-code');
  });

  it('marks the actions right before a failure, and says it ended on one', () => {
    const events = Array.from({ length: 8 }, (_, at) => event(`e${at}`, at));
    events.push(event('boom', 9, { exitCode: 1, operation: 'npm.build' }));
    const replay = buildReplay({ sessionId: 'ses_1', events });

    const marked = replay.steps.filter((step) => step.leadUp === true);
    expect(marked).toHaveLength(LEAD_UP_STEPS);
    expect(marked[marked.length - 1]?.eventId).toBe('boom');
    expect(replay.end).toBe(REPLAY_END.FAILED);
    expect(replay.endReason).toContain('exit 1');
  });

  it('reads a breaker trip as the end, and who lifted it', () => {
    const pause: SessionPause = {
      sessionId: 'ses_1',
      signal: 'error-loop',
      reason: 'the same failing command, again and again',
      reached: 5,
      ceiling: 5,
      pausedAt: '2026-09-24T10:04:30.000Z',
      resumedAt: '2026-09-24T10:20:00.000Z',
      resumedBy: 'ada',
    };
    const replay = buildReplay({
      sessionId: 'ses_1',
      events: [event('a', 1), event('b', 4, { exitCode: 2 }), event('c', 30)],
      pause,
    });

    expect(replay.end).toBe(REPLAY_END.TRIPPED);
    const kinds = replay.steps.map((step) => step.kind);
    expect(kinds).toEqual([
      REPLAY_STEP.ACTION,
      REPLAY_STEP.ACTION,
      REPLAY_STEP.TRIP,
      REPLAY_STEP.RESUME,
      REPLAY_STEP.ACTION,
    ]);
    expect(replay.steps[3]?.summary).toBe('resumed by ada');
    // The lead up is what came before the trip, never what followed it.
    expect(replay.steps[4]?.leadUp).toBeUndefined();
    expect(replay.steps[1]?.leadUp).toBe(true);
  });

  it('says what enforce would have done while it was only observed', () => {
    const replay = buildReplay({
      sessionId: 'ses_1',
      events: [event('a', 1, { mode: 'observe', shadowEffect: 'deny' })],
    });
    expect(replay.steps[0]?.wouldBe).toBe('deny');
    expect(replay.steps[0]?.summary).toContain('would be deny');
  });

  it('tells a failure the session went past from one it ended on', () => {
    const replay = buildReplay({
      sessionId: 'ses_1',
      events: [event('a', 1, { effect: 'deny' }), event('b', 2)],
    });
    expect(replay.end).toBe(REPLAY_END.RECOVERED);
  });

  it('survives a round trip through JSON, which is what --json prints', () => {
    const replay = buildReplay({ sessionId: 'ses_1', events: [event('a', 1)] });
    expect(JSON.parse(JSON.stringify(replay))).toEqual(replay);
  });
});

describe('what changed on the machine, beside what the session did', () => {
  it('puts a capability change in the order it happened, and leaves the ending alone', () => {
    const replay = buildReplay({
      sessionId: 'ses_1',
      events: [event('e1', 2), event('e2', 5, { operation: 'mcp.railway.redeploy' })],
      capability: [
        event('c1', 4, {
          sessionId: 'cfg_1',
          surface: 'config',
          operation: 'config.drift.new-write-tool',
          target: 'railway',
          reason: 'railway can now change something outside this machine',
        }),
      ],
    });
    expect(replay.steps.map((step) => step.kind)).toEqual([
      REPLAY_STEP.ACTION,
      REPLAY_STEP.CAPABILITY,
      REPLAY_STEP.ACTION,
    ]);
    expect(replay.steps[1]?.summary).toContain('config.drift.new-write-tool railway');
    expect(replay.end).toBe(REPLAY_END.CLEAN);
  });
});
