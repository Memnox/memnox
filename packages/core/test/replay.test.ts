import { describe, expect, it } from 'vitest';
import { breachIn } from '../src/session/breaker';
import { outcomesFrom } from '../src/session/replay';
import { EVENT_SCHEMA_VERSION, type MemnoxEvent } from '../src/event/event';

function event(over: Partial<MemnoxEvent> = {}): MemnoxEvent {
  return {
    id: 'evt_1',
    schemaVersion: EVENT_SCHEMA_VERSION,
    at: '2026-09-06T03:14:00.000Z',
    sessionId: 'ses_overnight',
    agent: 'hermes',
    actorType: 'agent',
    surface: 'shell',
    operation: 'npm.run',
    class: 'write',
    effect: 'allow',
    mode: 'enforce',
    reason: 'no rule matched',
    ...over,
  };
}

describe('replaying a session from the ledger', () => {
  /* The breaker lived only in the daemon and no seam ever spoke to one, so it observed
     nothing. The ledger is the session, and it needs no second process to be running. */
  it('turns a run of identical failures into the breach that stops it', () => {
    const events = Array.from({ length: 5 }, (_, n) =>
      event({ id: `e${n}`, at: `2026-09-06T03:1${n}:00.000Z`, exitCode: 1 }),
    );

    const breach = breachIn(outcomesFrom(events));

    expect(breach?.signal).toBe('error-loop');
    expect(breach?.reason).toContain('failed the same way');
  });

  it('does not trip on work that is succeeding', () => {
    const events = Array.from({ length: 20 }, (_, n) =>
      event({
        id: `e${n}`,
        at: `2026-09-06T03:${String(n).padStart(2, '0')}:00.000Z`,
        exitCode: 0,
      }),
    );

    expect(breachIn(outcomesFrom(events))).toBeNull();
  });

  /* A refusal cost nothing and ran nothing: counting denials as failures would let a
     strict policy trip the breaker it was protecting the session from. */
  it('ignores what never ran', () => {
    const denied = Array.from({ length: 9 }, (_, n) =>
      event({ id: `e${n}`, effect: 'deny', exitCode: 1 }),
    );

    expect(outcomesFrom(denied)).toEqual([]);
    expect(breachIn(outcomesFrom(denied))).toBeNull();
  });

  it('tells the same command apart from a different one', () => {
    const outcomes = outcomesFrom([
      event({ id: 'a', target: 'src/one.ts' }),
      event({ id: 'b', target: 'src/two.ts' }),
      event({ id: 'c', target: 'src/one.ts' }),
    ]);

    expect(new Set(outcomes.map((each) => each.fingerprint)).size).toBe(2);
  });

  it('reads the cost back, so a spend ceiling can trip from the record', () => {
    expect(outcomesFrom([event({ costUsd: 4.2 })])[0]?.costUsd).toBe(4.2);
  });
});
