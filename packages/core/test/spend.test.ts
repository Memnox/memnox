import { describe, expect, it } from 'vitest';
import { validateEvent } from '../src/event/event-schema';
import { EVENT_SCHEMA_VERSION, type MemnoxEvent } from '../src/event/event';
import { operationsReport } from '../src/session/operations';
import { spentOn, type Budget } from '../src/session/budget';

function event(over: Partial<MemnoxEvent> = {}): MemnoxEvent {
  return {
    id: 'evt_1',
    schemaVersion: EVENT_SCHEMA_VERSION,
    at: '2026-09-06T10:00:00.000Z',
    sessionId: 'ses_1',
    agent: 'hermes',
    actorType: 'agent',
    surface: 'network',
    operation: 'llm.completion',
    class: 'read',
    effect: 'allow',
    mode: 'observe',
    reason: 'reported spend',
    ...over,
  };
}

describe('a cost on the row', () => {
  it('is accepted as an additive optional field of v1', () => {
    expect(validateEvent(event({ costUsd: 0.42 }))).toEqual([]);
    expect(validateEvent(event())).toEqual([]);
  });

  /* Every total downstream is a sum of these, so the shapes that would make the sum
     meaningless are refused at the boundary rather than propagated. */
  it('refuses a cost that is not a finite, non-negative number', () => {
    expect(validateEvent(event({ costUsd: -1 }))).toContain('costUsd cannot be negative');
    expect(validateEvent(event({ costUsd: Number.NaN }))).toContain(
      'costUsd must be a finite number',
    );
    expect(validateEvent({ ...event(), costUsd: '0.42' } as unknown)).toContain(
      'costUsd must be a finite number',
    );
  });
});

describe('what a dollar budget counts', () => {
  const budget: Budget = {
    name: 'model spend',
    actions: ['llm.*'],
    limit: 25,
    window: 'day',
    unit: 'usd',
  };
  const now = '2026-09-06T12:00:00.000Z';

  it('adds up what was reported, and nothing else', () => {
    const events = [
      event({ id: 'a', costUsd: 3 }),
      event({ id: 'b', costUsd: 1.5 }),
      // No cost reported: counted as nothing rather than guessed at.
      event({ id: 'c' }),
    ];

    expect(spentOn(budget, events, now)).toBe(4.5);
  });

  it('never charges for an action that was refused', () => {
    const events = [
      event({ id: 'a', costUsd: 3, effect: 'deny' }),
      event({ id: 'b', costUsd: 2 }),
    ];

    // A strict policy must not exhaust the budget it was protecting.
    expect(spentOn(budget, events, now)).toBe(2);
  });

  it('ignores a cost on an action the budget does not cover', () => {
    const events = [event({ id: 'a', costUsd: 9, operation: 'git.push' })];

    expect(spentOn(budget, events, now)).toBe(0);
  });
});

describe('the day of operations', () => {
  const since = '2026-09-06T00:00:00.000Z';
  const until = '2026-09-06T23:59:59.000Z';

  /* A silence is not a zero: this machine cannot price a model call, and a $0.00
     beside real work would read as a fact somebody could act on. */
  it('has no spend line when nobody reported a cost', () => {
    const report = operationsReport([event({ id: 'a' })], since, until);

    expect(report.spentUsd).toBeNull();
    expect(report.wastedUsd).toBeNull();
  });

  it('adds up what was reported, and what of it went on work redone', () => {
    const events = [
      event({ id: 'a', operation: 'ci.fix', target: 'checkout', costUsd: 2 }),
      // The same action on the same target again: this one is work redone.
      event({ id: 'b', operation: 'ci.fix', target: 'checkout', costUsd: 3 }),
      event({ id: 'c', operation: 'llm.completion', costUsd: 1 }),
    ];

    const report = operationsReport(events, since, until);

    expect(report.spentUsd).toBe(6);
    expect(report.wastedUsd).toBe(3);
  });
});
