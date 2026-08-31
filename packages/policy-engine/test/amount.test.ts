import { describe, expect, it } from 'vitest';
import { DECISION_EFFECT } from '@memnox/core';
import { PolicyEngine } from '../src/policy-engine';
import { PolicyValidationError, validatePolicyDocument } from '../src/policy-validator';
import type { Policy } from '../src/policy';

/** "Refunds are fine" and "refunds under a thousand are fine" are different policies. */
const rule = (aboveAmount?: number): Policy => ({
  name: 'large-refunds',
  match: {
    actions: ['payment.refund'],
    ...(aboveAmount === undefined ? {} : { aboveAmount }),
  },
  decision: {
    effect: DECISION_EFFECT.ESCALATE,
    reason: 'a refund this size needs a person',
  },
});

const CONTEXT = { agentName: 'claude-code' };

const engine = (policy: Policy): PolicyEngine => new PolicyEngine([policy]);

describe('a rule that triggers above a size', () => {
  it('applies to an action bigger than the threshold', () => {
    const decision = engine(rule(1_000)).evaluate(
      { action: 'payment.refund', amount: 4_500 },
      CONTEXT,
    );
    expect(decision.effect).toBe(DECISION_EFFECT.ESCALATE);
  });

  it('leaves a smaller one alone', () => {
    const decision = engine(rule(1_000)).evaluate(
      { action: 'payment.refund', amount: 500 },
      CONTEXT,
    );
    expect(decision.effect).not.toBe(DECISION_EFFECT.ESCALATE);
  });

  it('does not trigger exactly at the threshold, because "above" means above', () => {
    const decision = engine(rule(1_000)).evaluate(
      { action: 'payment.refund', amount: 1_000 },
      CONTEXT,
    );
    expect(decision.effect).not.toBe(DECISION_EFFECT.ESCALATE);
  });

  /* A caller that omits the number must not thereby escape the rule the number
     exists for. It cannot prove it is under the line, so it is held to it. */
  it('applies to an action that never said how big it was', () => {
    const decision = engine(rule(1_000)).evaluate({ action: 'payment.refund' }, CONTEXT);
    expect(decision.effect).toBe(DECISION_EFFECT.ESCALATE);
  });

  it('is unset by default, so every existing rule is unchanged', () => {
    const decision = engine(rule()).evaluate(
      { action: 'payment.refund', amount: 1 },
      CONTEXT,
    );
    expect(decision.effect).toBe(DECISION_EFFECT.ESCALATE);
  });
});

describe('validating a threshold', () => {
  const document = (aboveAmount: unknown) => ({
    version: 1,
    policies: [
      {
        name: 'large-refunds',
        match: { actions: ['payment.refund'], aboveAmount },
        decision: { effect: 'escalate', approvers: ['finance'] },
      },
    ],
  });

  it('accepts a number, whole or not', () => {
    for (const good of [1_000, 0.5, 0]) {
      const parsed = validatePolicyDocument(document(good));
      expect(parsed.policies[0]?.match.aboveAmount).toBe(good);
    }
  });

  /* A threshold that failed to parse would silently become "applies to
     everything", which is the opposite of what the author wrote. */
  it('refuses anything that is not one', () => {
    for (const bad of ['1000', -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      try {
        validatePolicyDocument(document(bad));
        expect.unreachable(`accepted ${String(bad)}`);
      } catch (err) {
        expect(err).toBeInstanceOf(PolicyValidationError);
        expect(String(err)).toContain('aboveAmount');
      }
    }
  });
});
