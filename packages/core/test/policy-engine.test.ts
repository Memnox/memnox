import { describe, expect, it } from 'vitest';
import { DECISION_EFFECT, DECISION_REASON, RISK_LEVEL } from '@memnox/core';
import { PolicyEngine } from '../src/policy/policy-engine';
import type { Policy } from '../src/policy/policy';

const CONTEXT = { agentName: 'claude-code' };

const productionProtection: Policy = {
  name: 'production-database-protection',
  match: { actions: ['database.delete', 'database.drop'], environments: ['production'] },
  decision: {
    effect: DECISION_EFFECT.DENY,
    reason: 'No AI database deletion in production',
  },
};

const paymentApproval: Policy = {
  name: 'payment-code-approval',
  match: { actions: ['code.modify'], targets: ['payment/*'] },
  decision: { effect: DECISION_EFFECT.ASK, approvers: ['security-team'] },
};

describe('PolicyEngine', () => {
  const engine = new PolicyEngine([productionProtection, paymentApproval]);

  it('blocks a matching destructive action and reports the policy', () => {
    const result = engine.evaluate(
      { action: 'database.delete', target: 'users', environment: 'production' },
      CONTEXT,
    );
    expect(result.effect).toBe(DECISION_EFFECT.DENY);
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
    expect(result.effect).toBe(DECISION_EFFECT.ASK);
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
      decision: { effect: DECISION_EFFECT.ASK, approvers: ['dba'] },
    };
    const combined = new PolicyEngine([alsoApprove, productionProtection]);
    const result = combined.evaluate(
      { action: 'database.delete', environment: 'production' },
      CONTEXT,
    );
    expect(result.effect).toBe(DECISION_EFFECT.DENY);
    expect(result.matchedPolicies).toHaveLength(2);
  });

  it('honours a block-by-default configuration', () => {
    const strict = new PolicyEngine([], { defaultEffect: DECISION_EFFECT.DENY });
    const result = strict.evaluate({ action: 'anything.goes' }, CONTEXT);
    expect(result.effect).toBe(DECISION_EFFECT.DENY);
  });

  it('scopes policies to specific agents', () => {
    const cursorOnly: Policy = {
      name: 'cursor-restriction',
      match: { actions: ['deploy.*'], agents: ['cursor'] },
      decision: { effect: DECISION_EFFECT.DENY },
    };
    const engineWithAgentScope = new PolicyEngine([cursorOnly]);
    expect(
      engineWithAgentScope.evaluate({ action: 'deploy.service' }, { agentName: 'cursor' })
        .effect,
    ).toBe(DECISION_EFFECT.DENY);
    expect(
      engineWithAgentScope.evaluate({ action: 'deploy.service' }, CONTEXT).effect,
    ).toBe(DECISION_EFFECT.ALLOW);
  });
});

describe('what a rule set pulled from elsewhere can do', () => {
  /* A workspace bundle is registered as another policy file, so this is the
     property that makes pulling rules over a network safe at all: a control
     plane, or anything that managed to answer as one, can deny more and can
     never grant. Without it, an `allow` in a bundle would be a remote way to
     open a gate somebody closed locally. */
  it('can only tighten what is already enforced, never loosen it', () => {
    const local: Policy = {
      name: 'local-deny',
      match: { actions: ['gh.pr-merge'] },
      decision: { effect: DECISION_EFFECT.DENY, reason: 'merges are reviewed here' },
    };
    const pulled: Policy = {
      name: 'workspace-allow',
      match: { actions: ['gh.pr-merge'] },
      decision: { effect: DECISION_EFFECT.ALLOW, reason: 'the workspace says fine' },
    };

    const verdict = new PolicyEngine([local, pulled]).evaluate(
      { action: 'gh.pr-merge' },
      { agentName: 'agent' },
    );

    expect(verdict.effect).toBe(DECISION_EFFECT.DENY);
    expect(verdict.reason).toContain('reviewed here');
  });

  it('may still tighten an allow into an ask, which is the point of pulling any', () => {
    const local: Policy = {
      name: 'local-allow',
      match: { actions: ['railway.up'] },
      decision: { effect: DECISION_EFFECT.ALLOW, reason: 'fine locally' },
    };
    const pulled: Policy = {
      name: 'workspace-ask',
      match: { actions: ['railway.up'] },
      decision: {
        effect: DECISION_EFFECT.ASK,
        reason: 'a deploy is somebody else’s call',
      },
    };

    expect(
      new PolicyEngine([local, pulled]).evaluate(
        { action: 'railway.up' },
        { agentName: 'agent' },
      ).effect,
    ).toBe(DECISION_EFFECT.ASK);
  });
});
