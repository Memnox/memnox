import { describe, expect, it } from 'vitest';
import { PolicyEngine } from '../src/policy/policy-engine';
import { validatePolicyDocument } from '../src/policy/policy-validator';
import type { Policy } from '../src/policy/policy';

const rule = (principals?: string[]): Policy => ({
  name: 'cfo-refunds',
  match: {
    actions: ['payment.refund'],
    ...(principals === undefined ? {} : { principals }),
  },
  decision: {
    effect: 'ask',
    reason: 'refunds taken for the CFO need a second pair of eyes',
    approvers: ['finance-manager'],
  },
});

const evaluate = (
  policies: Policy[],
  principal: string | undefined,
): ReturnType<PolicyEngine['evaluate']> =>
  new PolicyEngine(policies).evaluate(
    { action: 'payment.refund', ...(principal === undefined ? {} : { principal }) },
    { agentName: 'assistant', now: new Date('2026-06-01T00:00:00.000Z') },
  );

describe('matching on the person an agent acts for', () => {
  it('applies to the principal it names', () => {
    expect(evaluate([rule(['cfo@acme.com'])], 'cfo@acme.com').effect).toBe('ask');
  });

  it('leaves another principal alone', () => {
    expect(evaluate([rule(['cfo@acme.com'])], 'intern@acme.com').effect).toBe('allow');
  });

  it('matches a principal pattern, so a team is one rule', () => {
    expect(evaluate([rule(['*@finance.acme.com'])], 'lead@finance.acme.com').effect).toBe(
      'ask',
    );
  });

  it('applies to every principal when the rule names none', () => {
    expect(evaluate([rule()], 'anyone@acme.com').effect).toBe('ask');
    expect(evaluate([rule()], undefined).effect).toBe('ask');
  });

  it('does not apply a principal-scoped rule to an action that names nobody', () => {
    expect(evaluate([rule(['cfo@acme.com'])], undefined).effect).toBe('allow');
  });

  it('governs every agent acting for a principal without naming one', () => {
    const engine = new PolicyEngine([rule(['cfo@acme.com'])]);
    const forCfo = { action: 'payment.refund', principal: 'cfo@acme.com' };

    for (const agentName of ['assistant', 'finance-bot', 'a-tool-nobody-has-built-yet']) {
      expect(engine.evaluate(forCfo, { agentName }).effect).toBe('ask');
    }
  });

  it('survives the validator, so it can be written in a policy file', () => {
    const document = validatePolicyDocument({
      version: 1,
      policies: [
        {
          name: 'cfo-refunds',
          match: { actions: ['payment.refund'], principals: ['cfo@acme.com'] },
          decision: { effect: 'ask', approvers: ['finance-manager'] },
        },
      ],
    });

    expect(document.policies[0]?.match.principals).toEqual(['cfo@acme.com']);
  });
});
