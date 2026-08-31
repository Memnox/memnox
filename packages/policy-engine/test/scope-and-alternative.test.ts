import { describe, expect, it } from 'vitest';
import { DECISION_EFFECT, SCOPE_MATCH } from '@memnox/core';
import { PolicyEngine } from '../src/policy-engine';
import { validatePolicyDocument, PolicyValidationError } from '../src/policy-validator';
import type { Policy } from '../src/policy';

const SECRETS_RULE: Policy = {
  name: 'secrets-not-required',
  match: {
    actions: ['filesystem.read'],
    targets: ['.env'],
    scope: [SCOPE_MATCH.OUT_OF_SCOPE],
  },
  decision: {
    effect: DECISION_EFFECT.WITHHOLD,
    reason: 'This task declared no credential need.',
    alternative: {
      action: 'filesystem.read',
      resource: '.env.example',
      note: '.env.example is readable.',
    },
  },
};

const engine = new PolicyEngine([SECRETS_RULE]);
const read = { action: 'filesystem.read', target: '.env' };

describe('a rule that matches on declared scope', () => {
  it('withholds when the request fell outside what the task declared', () => {
    const result = engine.evaluate(read, {
      agentName: 'claude-code',
      scope: SCOPE_MATCH.OUT_OF_SCOPE,
    });

    expect(result.effect).toBe(DECISION_EFFECT.WITHHOLD);
    expect(result.rule?.name).toBe('secrets-not-required');
  });

  it('does not match when the caller declared no task at all', () => {
    // Undeclared is a silence. Treating it as out of scope would refuse every
    // request from a client that never learned to declare one.
    const result = engine.evaluate(read, { agentName: 'claude-code' });

    expect(result.effect).toBe(DECISION_EFFECT.ALLOW);
  });

  it('does not match a request the task did cover', () => {
    const result = engine.evaluate(read, {
      agentName: 'claude-code',
      scope: SCOPE_MATCH.IN_SCOPE,
    });

    expect(result.effect).toBe(DECISION_EFFECT.ALLOW);
  });
});

describe('the alternative a rule names', () => {
  it('is resolved from the rule rather than invented', () => {
    const result = engine.evaluate(read, {
      agentName: 'claude-code',
      scope: SCOPE_MATCH.OUT_OF_SCOPE,
    });

    expect(result.alternative).toEqual({
      action: 'filesystem.read',
      resource: '.env.example',
      note: '.env.example is readable.',
    });
  });

  it('is refused without a note, because the note is what the agent reads', () => {
    expect(() =>
      validatePolicyDocument({
        version: 1,
        policies: [
          {
            name: 'no-note',
            match: { actions: ['filesystem.read'] },
            decision: {
              effect: DECISION_EFFECT.WITHHOLD,
              alternative: { action: 'filesystem.read' },
            },
          },
        ],
      }),
    ).toThrow(PolicyValidationError);
  });

  it('survives a round trip through the validator', () => {
    const doc = validatePolicyDocument({ version: 1, policies: [SECRETS_RULE] });

    expect(doc.policies[0]?.decision.alternative?.resource).toBe('.env.example');
    expect(doc.policies[0]?.match.scope).toEqual([SCOPE_MATCH.OUT_OF_SCOPE]);
  });
});
