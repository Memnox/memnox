import { describe, expect, it } from 'vitest';
import {
  ACTOR_TYPE,
  DECISION_EFFECT,
  ENFORCEMENT_MODE,
  EVENT_SCHEMA_VERSION,
  EVENT_SURFACE,
  EXECUTION,
  TOOL_CLASS,
  type MemnoxEvent,
} from '../src/index';
import { operationsReport, recommendation } from '../src/session/operations';

const SINCE = '2026-09-04T10:00:00.000Z';
const NOW = '2026-09-05T10:00:00.000Z';

const event = (over: Partial<MemnoxEvent> = {}): MemnoxEvent => ({
  id: `evt_${Math.random().toString(36).slice(2, 10)}`,
  schemaVersion: EVENT_SCHEMA_VERSION,
  at: '2026-09-05T09:00:00.000Z',
  sessionId: 'ses_1',
  agent: 'claude-code',
  actorType: ACTOR_TYPE.AGENT,
  surface: EVENT_SURFACE.SHELL,
  operation: 'npm.test',
  class: TOOL_CLASS.READ,
  effect: DECISION_EFFECT.ALLOW,
  mode: ENFORCEMENT_MODE.ENFORCE,
  reason: 'ok',
  exitCode: 0,
  ...over,
});

const times = (n: number, over: Partial<MemnoxEvent> = {}): MemnoxEvent[] =>
  Array.from({ length: n }, () => event(over));

describe('a day of agent operations', () => {
  it('adds up what happened', () => {
    const report = operationsReport(
      [
        ...times(3),
        ...times(2, { exitCode: 1 }),
        event({ effect: DECISION_EFFECT.DENY }),
        event({ effect: DECISION_EFFECT.ASK }),
      ],
      SINCE,
      NOW,
    );
    expect(report.actions).toBe(7);
    expect(report.succeeded).toBe(3);
    expect(report.failed).toBe(2);
    expect(report.blocked).toBe(1);
    expect(report.held).toBe(1);
  });

  it('ignores what fell outside the window', () => {
    const old = times(5, { at: '2026-08-01T10:00:00.000Z' });
    expect(operationsReport([...old, event()], SINCE, NOW).actions).toBe(1);
  });

  it('counts the same work on the same target as redone', () => {
    const report = operationsReport(times(4, { target: 'src/a.ts' }), SINCE, NOW);
    // Four runs of one thing is three repeats, not four.
    expect(report.retries).toBe(3);
  });

  it('does not call different targets a repeat', () => {
    const report = operationsReport(
      [event({ target: 'a' }), event({ target: 'b' })],
      SINCE,
      NOW,
    );
    expect(report.retries).toBe(0);
  });

  it('names where the work went twice, worst first', () => {
    const report = operationsReport(
      [
        ...times(6, { operation: 'browser.open', exitCode: 1 }),
        ...times(2, { operation: 'npm.test', exitCode: 1 }),
      ],
      SINCE,
      NOW,
    );
    expect(report.waste[0]?.action).toBe('browser.open');
    expect(report.waste[0]?.failures).toBe(6);
  });

  it('reads a failed execution even without an exit code', () => {
    const report = operationsReport(
      times(2, { execution: EXECUTION.FAILED, exitCode: undefined }),
      SINCE,
      NOW,
    );
    expect(report.failed).toBe(2);
  });

  it('names the busiest agent', () => {
    const report = operationsReport(
      [...times(5), ...times(2, { agent: 'cursor' })],
      SINCE,
      NOW,
    );
    expect(report.busiest?.agent).toBe('claude-code');
    expect(report.agents).toBe(2);
  });

  it('counts nothing on a quiet day rather than failing', () => {
    const report = operationsReport([], SINCE, NOW);
    expect(report.actions).toBe(0);
    expect(report.waste).toEqual([]);
    expect(report.busiest).toBeNull();
  });
});

describe('the one recommendation it may make', () => {
  /* A screen that always ends with "enable the circuit breaker" is an advertisement,
     and people stop reading the rest of it. */
  it('says nothing when the ledger shows no loop', () => {
    expect(recommendation(operationsReport(times(3), SINCE, NOW))).toBeNull();
  });

  it('says nothing about a thing that failed twice', () => {
    const report = operationsReport(times(2, { exitCode: 1 }), SINCE, NOW);
    expect(recommendation(report)).toBeNull();
  });

  it('speaks up when something failed five times or more', () => {
    const report = operationsReport(times(6, { exitCode: 1 }), SINCE, NOW);
    expect(recommendation(report)).toContain('npm.test');
    expect(recommendation(report)).toContain('breaker');
  });
});
