import { describe, expect, it } from 'vitest';
import {
  DECISION_EFFECT,
  EXECUTION_OUTCOME_ACTION,
  EXECUTION_STATUS,
  RISK_LEVEL,
  type ActionEvent,
} from '@memnox/core';
import { LLM_SPEND_ACTION } from '@memnox/risk';
import { buildComplianceReport } from '../src/reporting';

const decision = (id: string, over: Partial<ActionEvent> = {}): ActionEvent => ({
  id,
  occurredAt: '2026-07-31T12:00:00.000Z',
  agentId: 'agent-1',
  agentName: 'claude-code',
  action: 'code.modify',
  effect: DECISION_EFFECT.ALLOW,
  riskLevel: RISK_LEVEL.LOW,
  matchedPolicies: [],
  advisories: [],
  reason: 'no policy matched',
  ...over,
});

const outcome = (decisionEventId: string, over: Partial<ActionEvent> = {}): ActionEvent =>
  decision(`${decisionEventId}-outcome`, {
    action: EXECUTION_OUTCOME_ACTION,
    decisionEventId,
    executionStatus: EXECUTION_STATUS.SUCCEEDED,
    rolledBack: false,
    rollbackFailed: false,
    ...over,
  });

/** Far enough past the fixtures' occurredAt that nothing is in flight by accident. */
const NOW = new Date('2026-07-31T13:00:00.000Z');

const coverageOf = (events: ActionEvent[]) =>
  buildComplianceReport(events, {}, NOW).verification;

describe('verification coverage', () => {
  it('counts an allowed decision with no outcome as unreported', () => {
    const coverage = coverageOf([decision('a'), decision('b'), outcome('a')]);

    expect(coverage.allowed).toBe(2);
    expect(coverage.reported).toBe(1);
    expect(coverage.unreported).toBe(1);
    expect(coverage.succeeded).toBe(1);
    // Silence is missing testimony, never a failure.
    expect(coverage.failed).toBe(0);
    expect(coverage.unreportedActions).toEqual([{ action: 'code.modify', count: 1 }]);
  });

  it('counts a postcondition failure as failed, not succeeded', () => {
    const coverage = coverageOf([
      decision('a'),
      outcome('a', {
        executionStatus: EXECUTION_STATUS.POSTCONDITION_FAILED,
        rolledBack: true,
      }),
    ]);

    expect(coverage.failed).toBe(1);
    expect(coverage.succeeded).toBe(0);
    expect(coverage.rolledBack).toBe(1);
    expect(coverage.rollbackFailed).toBe(0);
  });

  it('counts a failed rollback separately — state is unknown', () => {
    const coverage = coverageOf([
      decision('a'),
      outcome('a', {
        executionStatus: EXECUTION_STATUS.EXECUTION_FAILED,
        rolledBack: false,
        rollbackFailed: true,
      }),
    ]);

    expect(coverage.failed).toBe(1);
    expect(coverage.rollbackFailed).toBe(1);
  });

  it('ignores withheld decisions — nothing ran, so nothing can be reported', () => {
    const coverage = coverageOf([
      decision('a', { effect: DECISION_EFFECT.WITHHOLD }),
      decision('b', { effect: DECISION_EFFECT.ESCALATE }),
    ]);

    expect(coverage.allowed).toBe(0);
    expect(coverage.unreported).toBe(0);
  });

  it('excludes bookkeeping events from the denominator', () => {
    const coverage = coverageOf([
      decision('a'),
      outcome('a'),
      decision('spend', { action: LLM_SPEND_ACTION }),
    ]);

    // The outcome event and the spend record are audited, not authorized actions.
    expect(coverage.allowed).toBe(1);
    expect(coverage.unreported).toBe(0);
  });

  it('ignores an outcome whose decision is outside the queried period', () => {
    const coverage = coverageOf([outcome('gone')]);

    expect(coverage.allowed).toBe(0);
    expect(coverage.reported).toBe(0);
  });

  it('counts a just-allowed decision as in flight, not unreported', () => {
    const coverage = coverageOf([
      decision('fresh', { occurredAt: '2026-07-31T12:59:30.000Z' }),
    ]);

    expect(coverage.inFlight).toBe(1);
    expect(coverage.unreported).toBe(0);
    // Nothing is owed yet, so it must not appear on the chase list.
    expect(coverage.unreportedActions).toEqual([]);
  });

  it('counts a decision past the grace period as unreported', () => {
    const coverage = coverageOf([
      decision('stale', { occurredAt: '2026-07-31T12:50:00.000Z' }),
    ]);

    expect(coverage.unreported).toBe(1);
    expect(coverage.inFlight).toBe(0);
  });

  it('reports an outcome regardless of how recent the decision was', () => {
    const coverage = coverageOf([
      decision('fresh', { occurredAt: '2026-07-31T12:59:30.000Z' }),
      outcome('fresh'),
    ]);

    expect(coverage.reported).toBe(1);
    expect(coverage.inFlight).toBe(0);
  });
});
