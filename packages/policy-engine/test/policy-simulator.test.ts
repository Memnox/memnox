import { describe, expect, it } from 'vitest';
import { DECISION_EFFECT } from '@memnox/core';
import { PolicyEngine } from '../src/policy-engine';
import { comparePolicySets, simulate } from '../src/policy-simulator';
import type { Policy } from '../src/policy';

const BLOCK_PROD_DELETE: Policy = {
  name: 'production-database-protection',
  match: { actions: ['database.delete'], environments: ['production'] },
  decision: { effect: DECISION_EFFECT.WITHHOLD, reason: 'no prod deletes' },
};

const APPROVE_PAYMENTS: Policy = {
  name: 'payment-code-approval',
  match: { actions: ['code.modify'], targets: ['payment/*'] },
  decision: { effect: DECISION_EFFECT.ESCALATE, approvers: ['security'] },
};

const CASES = [
  { action: 'database.delete', environment: 'production', agentName: 'claude-code' },
  { action: 'database.delete', environment: 'staging', agentName: 'claude-code' },
  { action: 'code.modify', target: 'payment/checkout.ts', agentName: 'claude-code' },
  { action: 'code.modify', target: 'blog/post.ts', agentName: 'claude-code' },
];

describe('simulate', () => {
  it('reports the effect and matching policies for each case', () => {
    const outcomes = simulate(new PolicyEngine([BLOCK_PROD_DELETE]), CASES);

    expect(outcomes[0]?.effect).toBe(DECISION_EFFECT.WITHHOLD);
    expect(outcomes[0]?.matchedPolicies).toEqual(['production-database-protection']);
    expect(outcomes[1]?.effect).toBe(DECISION_EFFECT.ALLOW);
    expect(outcomes[1]?.matchedPolicies).toEqual([]);
  });

  it('respects the engine default effect for unmatched actions', () => {
    const strict = new PolicyEngine([], { defaultEffect: DECISION_EFFECT.WITHHOLD });
    expect(
      simulate(strict, CASES).every((o) => o.effect === DECISION_EFFECT.WITHHOLD),
    ).toBe(true);
  });
});

describe('comparePolicySets', () => {
  it('lists what a new policy would newly catch', () => {
    const comparison = comparePolicySets(
      new PolicyEngine([BLOCK_PROD_DELETE]),
      new PolicyEngine([BLOCK_PROD_DELETE, APPROVE_PAYMENTS]),
      CASES,
    );

    expect(comparison.total).toBe(4);
    expect(comparison.changes).toHaveLength(1);
    expect(comparison.changes[0]?.case.target).toBe('payment/checkout.ts');
    expect(comparison.changes[0]?.before).toBe(DECISION_EFFECT.ALLOW);
    expect(comparison.changes[0]?.after).toBe(DECISION_EFFECT.ESCALATE);
    expect(comparison.changes[0]?.stricter).toBe(true);
    expect(comparison.unchanged).toBe(3);
  });

  it('flags a change that makes the rules more permissive', () => {
    const comparison = comparePolicySets(
      new PolicyEngine([BLOCK_PROD_DELETE]),
      new PolicyEngine([]),
      CASES,
    );

    expect(comparison.changes).toHaveLength(1);
    expect(comparison.changes[0]?.stricter).toBe(false);
    expect(comparison.changes[0]?.after).toBe(DECISION_EFFECT.ALLOW);
  });

  it('counts where every case lands under the candidate set', () => {
    const comparison = comparePolicySets(
      new PolicyEngine([]),
      new PolicyEngine([BLOCK_PROD_DELETE, APPROVE_PAYMENTS]),
      CASES,
    );

    expect(comparison.candidateTotals[DECISION_EFFECT.WITHHOLD]).toBe(1);
    expect(comparison.candidateTotals[DECISION_EFFECT.ESCALATE]).toBe(1);
    expect(comparison.candidateTotals[DECISION_EFFECT.ALLOW]).toBe(2);
  });

  it('reports no changes when the sets decide identically', () => {
    const comparison = comparePolicySets(
      new PolicyEngine([BLOCK_PROD_DELETE]),
      new PolicyEngine([BLOCK_PROD_DELETE]),
      CASES,
    );
    expect(comparison.changes).toEqual([]);
    expect(comparison.unchanged).toBe(4);
  });
});

describe('project-scoped rules', () => {
  const SCOPED: Policy = {
    name: 'auth-code-review',
    project: 'memnox-client',
    match: { actions: ['file.write'], targets: ['*/auth/*'] },
    decision: { effect: DECISION_EFFECT.ESCALATE, reason: 'auth needs review' },
  };

  it('applies a scoped rule to a case that names the same project', () => {
    const [outcome] = simulate(new PolicyEngine([SCOPED]), [
      { action: 'file.write', target: 'app/auth/login.ts', projectId: 'memnox-client' },
    ]);

    expect(outcome?.effect).toBe(DECISION_EFFECT.ESCALATE);
    expect(outcome?.matchedPolicies).toEqual(['auth-code-review']);
  });

  it('reports the change instead of a false all-clear', () => {
    const comparison = comparePolicySets(
      new PolicyEngine([]),
      new PolicyEngine([SCOPED]),
      [{ action: 'file.write', target: 'app/auth/login.ts', projectId: 'memnox-client' }],
    );

    expect(comparison.changes).toHaveLength(1);
    expect(comparison.changes[0]?.stricter).toBe(true);
  });

  it('leaves another project\u2019s actions alone', () => {
    const [outcome] = simulate(new PolicyEngine([SCOPED]), [
      { action: 'file.write', target: 'app/auth/login.ts', projectId: 'other-app' },
    ]);

    expect(outcome?.effect).toBe(DECISION_EFFECT.ALLOW);
  });
});
