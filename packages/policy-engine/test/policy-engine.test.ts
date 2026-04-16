import { describe, expect, it } from 'vitest';
import { DECISION_EFFECT, DECISION_REASON, RISK_LEVEL } from '@memnox/core';
import { PolicyEngine } from '../src/policy-engine';
import type { Policy } from '../src/policy';

const CONTEXT = { agentName: 'claude-code' };

const productionProtection: Policy = {
  name: 'production-database-protection',
  match: { actions: ['database.delete', 'database.drop'], environments: ['production'] },
  decision: {
    effect: DECISION_EFFECT.BLOCK,
    reason: 'No AI database deletion in production',
  },
};

const paymentApproval: Policy = {
  name: 'payment-code-approval',
  match: { actions: ['code.modify'], targets: ['payment/*'] },
  decision: { effect: DECISION_EFFECT.REQUIRE_APPROVAL, approvers: ['security-team'] },
};

describe('PolicyEngine', () => {
  const engine = new PolicyEngine([productionProtection, paymentApproval]);

  it('blocks a matching destructive action and reports the policy', () => {
    const result = engine.evaluate(
      { action: 'database.delete', target: 'users', environment: 'production' },
      CONTEXT,
    );
    expect(result.effect).toBe(DECISION_EFFECT.BLOCK);
    expect(result.reason).toBe('No AI database deletion in production');
    expect(result.matchedPolicies.map((p) => p.name)).toEqual([
      'production-database-protection',
    ]);
    expect(result.riskLevel).toBe(RISK_LEVEL.CRITICAL);
  });

  it('requires approval for protected targets', () => {
    const result = engine.evaluate(
      { action: 'code.modify', target: 'payment/checkout.ts' },
      CONTEXT,
    );
    expect(result.effect).toBe(DECISION_EFFECT.REQUIRE_APPROVAL);
    expect(result.matchedPolicies[0]?.approvers).toEqual(['security-team']);
  });

  it('applies the default effect when nothing matches', () => {
    const result = engine.evaluate({ action: 'repository.read' }, CONTEXT);
    expect(result.effect).toBe(DECISION_EFFECT.ALLOW);
    expect(result.reason).toBe(DECISION_REASON.NO_POLICY_MATCHED);
    expect(result.riskLevel).toBe(RISK_LEVEL.LOW);
  });

  it('lets the most restrictive effect win when multiple policies match', () => {
    const alsoApprove: Policy = {
      name: 'database-approval',
      match: { actions: ['database.*'] },
      decision: { effect: DECISION_EFFECT.REQUIRE_APPROVAL, approvers: ['dba'] },
    };
    const combined = new PolicyEngine([alsoApprove, productionProtection]);
    const result = combined.evaluate(
      { action: 'database.delete', environment: 'production' },
      CONTEXT,
    );
    expect(result.effect).toBe(DECISION_EFFECT.BLOCK);
    expect(result.matchedPolicies).toHaveLength(2);
  });

  it('honours a block-by-default configuration', () => {
    const strict = new PolicyEngine([], { defaultEffect: DECISION_EFFECT.BLOCK });
    const result = strict.evaluate({ action: 'anything.goes' }, CONTEXT);
    expect(result.effect).toBe(DECISION_EFFECT.BLOCK);
  });

  it('scopes policies to specific agents', () => {
    const cursorOnly: Policy = {
      name: 'cursor-restriction',
      match: { actions: ['deploy.*'], agents: ['cursor'] },
      decision: { effect: DECISION_EFFECT.BLOCK },
    };
    const engineWithAgentScope = new PolicyEngine([cursorOnly]);
    expect(
      engineWithAgentScope.evaluate({ action: 'deploy.service' }, { agentName: 'cursor' })
        .effect,
    ).toBe(DECISION_EFFECT.BLOCK);
    expect(
      engineWithAgentScope.evaluate({ action: 'deploy.service' }, CONTEXT).effect,
    ).toBe(DECISION_EFFECT.ALLOW);
  });
});
