import { describe, expect, it } from 'vitest';
import { ACTOR_TYPE, DECISION_EFFECT, EVENT_SURFACE, TOOL_CLASS } from '@memnox/core';
import { eventFor } from '../src/record';
import type { InterceptOutcome } from '../src/interceptor';

const outcome = (over: Partial<InterceptOutcome> = {}): InterceptOutcome => ({
  allowed: false,
  binary: 'railway',
  args: ['delete'],
  action: 'railway.delete',
  class: TOOL_CLASS.DESTRUCTIVE,
  argsDigest: 'abc123',
  ...over,
});

const AT = '2026-09-05T10:00:00.000Z';

describe('the row behind why, timeline and trace', () => {
  /* Every reader of the ledger existed before any writer did, so "nothing recorded yet"
     was the answer on a machine that had been governing commands all day. */
  it('records what was attempted and what was decided', () => {
    const event = eventFor({
      outcome: outcome(),
      effect: DECISION_EFFECT.DENY,
      reason: 'payments is frozen',
      at: AT,
      sessionId: 'ses_x',
    });

    expect(event.operation).toBe('railway.delete');
    expect(event.effect).toBe(DECISION_EFFECT.DENY);
    expect(event.reason).toBe('payments is frozen');
    expect(event.actorType).toBe(ACTOR_TYPE.AGENT);
  });

  /* An argument list is where a secret would be, so the row carries a digest of it and
     the arguments themselves never reach the database. */
  it('carries a digest of the arguments and never the arguments', () => {
    const event = eventFor({
      outcome: outcome({ args: ['delete', '--token', 'sk_live_not_a_real_one'] }),
      effect: DECISION_EFFECT.DENY,
      reason: 'no',
      at: AT,
    });

    expect(event.argsDigest).toBe('abc123');
    expect(JSON.stringify(event)).not.toContain('sk_live');
  });

  it('records git under its own surface, so a timeline can be read by it', () => {
    const git = eventFor({
      outcome: outcome({ binary: 'git', action: 'git.push-force' }),
      effect: DECISION_EFFECT.ALLOW,
      reason: 'no rule matched',
      at: AT,
    });

    expect(git.surface).toBe(EVENT_SURFACE.GIT);
  });

  // A class the ledger does not know is unknown, and unknown is never a safe one.
  it('never records a class it does not know as a harmless one', () => {
    const event = eventFor({
      outcome: outcome({ class: 'martian' }),
      effect: DECISION_EFFECT.ALLOW,
      reason: 'no rule matched',
      at: AT,
    });

    expect(event.class).toBe(TOOL_CLASS.UNKNOWN);
  });

  it('carries the exit code and the duration, which is what trace is for', () => {
    const event = eventFor({
      outcome: outcome({ allowed: true }),
      effect: DECISION_EFFECT.ALLOW,
      reason: 'no rule matched',
      at: AT,
      exitCode: 3,
      durationMs: 412,
    });

    expect(event.exitCode).toBe(3);
    expect(event.durationMs).toBe(412);
  });
});
