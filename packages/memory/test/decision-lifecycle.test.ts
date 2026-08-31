import { describe, expect, it } from 'vitest';
import { fingerprintDecision } from '../src/decision-fingerprint';
import {
  buildDecisionHealthReport,
  FREQUENT_VIOLATION_THRESHOLD,
} from '../src/decision-health';
import {
  DECISION_ENFORCEMENT,
  DECISION_STATUS,
  isEnforcing,
  type DecisionRecord,
} from '../src/decision-record';

function decision(overrides: Partial<DecisionRecord>): DecisionRecord {
  return {
    id: 'dec-1',
    title: 'No DB migration before Q4',
    statement: 'Do not migrate the database before Q4.',
    owner: 'CTO',
    decidedAt: new Date().toISOString(),
    actions: ['database.migrate'],
    enforcement: DECISION_ENFORCEMENT.WITHHOLD,
    ...overrides,
  };
}

describe('fingerprintDecision', () => {
  it('converges restatements of the same decision', () => {
    const slackVersion = decision({
      statement: '  Do not   migrate the DATABASE before Q4. ',
      actions: ['Database.Migrate'],
    });
    expect(fingerprintDecision(slackVersion)).toBe(fingerprintDecision(decision({})));
  });

  it('distinguishes decisions with different scope', () => {
    const other = decision({
      actions: ['database.migrate'],
      environments: ['production'],
    });
    expect(fingerprintDecision(other)).not.toBe(fingerprintDecision(decision({})));
  });

  it('ignores who recorded the decision', () => {
    expect(
      fingerprintDecision(decision({ owner: 'someone-else', title: 'other title' })),
    ).toBe(fingerprintDecision(decision({})));
  });
});

describe('decision lifecycle', () => {
  it('only active decisions enforce; missing status means active', () => {
    expect(isEnforcing(decision({}))).toBe(true);
    expect(isEnforcing(decision({ status: DECISION_STATUS.ACTIVE }))).toBe(true);
    expect(isEnforcing(decision({ status: DECISION_STATUS.SUPERSEDED }))).toBe(false);
    expect(isEnforcing(decision({ status: DECISION_STATUS.RETIRED }))).toBe(false);
  });
});

describe('buildDecisionHealthReport', () => {
  const now = new Date('2026-07-01T00:00:00.000Z');

  it('scores a healthy corpus high and an unhealthy one low', () => {
    const fresh = decision({ id: 'fresh', decidedAt: '2026-06-20T00:00:00.000Z' });
    const healthy = buildDecisionHealthReport([fresh], new Map([['fresh', 1]]), now);
    expect(healthy.score).toBe(100);

    const stale = decision({ id: 'stale', decidedAt: '2025-01-01T00:00:00.000Z' });
    const broken = decision({ id: 'broken', decidedAt: '2026-06-20T00:00:00.000Z' });
    const unhealthy = buildDecisionHealthReport(
      [stale, broken],
      new Map([['broken', FREQUENT_VIOLATION_THRESHOLD]]),
      now,
    );
    expect(unhealthy.stale).toBe(1);
    expect(unhealthy.frequentlyViolated).toBe(1);
    expect(unhealthy.neverReferenced).toBe(1);
    expect(unhealthy.score).toBeLessThan(70);
  });

  it('flags decisions past their review date but keeps them enforcing', () => {
    const due = decision({
      id: 'due',
      decidedAt: '2026-06-20T00:00:00.000Z',
      reviewAfter: '2026-06-30T00:00:00.000Z',
    });
    const report = buildDecisionHealthReport([due], new Map([['due', 1]]), now);
    expect(report.entries[0]?.dueForReview).toBe(true);
    expect(isEnforcing(due)).toBe(true);
  });

  it('excludes superseded and retired decisions from the corpus', () => {
    const superseded = decision({ id: 'old', status: DECISION_STATUS.SUPERSEDED });
    const report = buildDecisionHealthReport([superseded], new Map(), now);
    expect(report.activeDecisions).toBe(0);
    expect(report.score).toBe(100);
  });
});
