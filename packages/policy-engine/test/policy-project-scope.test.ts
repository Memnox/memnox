import { describe, expect, it } from 'vitest';
import { DECISION_EFFECT } from '@memnox/core';
import { PolicyEngine } from '../src/policy-engine';
import type { Policy } from '../src/policy';

const rule = (name: string, effect: string, project?: string): Policy =>
  ({
    name,
    match: { actions: ['file.write'] },
    decision: { effect: effect as Policy['decision']['effect'], reason: name },
    project,
  }) as Policy;

const context = { agentName: 'local-editor' };

describe('policy project scope', () => {
  it('applies a project rule to its own project', () => {
    const engine = new PolicyEngine([rule('api-rule', DECISION_EFFECT.BLOCK, 'acme')]);

    const result = engine.evaluate({ action: 'file.write', projectId: 'acme' }, context);

    expect(result.effect).toBe(DECISION_EFFECT.BLOCK);
  });

  it('never lets one project decide another project action', () => {
    const engine = new PolicyEngine([rule('api-rule', DECISION_EFFECT.BLOCK, 'acme')]);

    const result = engine.evaluate(
      { action: 'file.write', projectId: 'billing' },
      context,
    );

    expect(result.effect).toBe(DECISION_EFFECT.ALLOW);
    expect(result.matchedPolicies).toEqual([]);
  });

  it('keeps an unscoped rule as the shared baseline', () => {
    const engine = new PolicyEngine([rule('baseline', DECISION_EFFECT.BLOCK)]);

    expect(
      engine.evaluate({ action: 'file.write', projectId: 'anything' }, context).effect,
    ).toBe(DECISION_EFFECT.BLOCK);
    expect(engine.evaluate({ action: 'file.write' }, context).effect).toBe(
      DECISION_EFFECT.BLOCK,
    );
  });

  it('composes two repositories of one project, most restrictive winning', () => {
    const engine = new PolicyEngine([
      rule('web-rule', DECISION_EFFECT.ALLOW, 'acme'),
      rule('api-rule', DECISION_EFFECT.BLOCK, 'acme'),
    ]);

    const result = engine.evaluate({ action: 'file.write', projectId: 'acme' }, context);

    expect(result.effect).toBe(DECISION_EFFECT.BLOCK);
    expect(result.matchedPolicies).toHaveLength(2);
  });

  it('leaves a project action outside every scoped rule alone', () => {
    const engine = new PolicyEngine([rule('api-rule', DECISION_EFFECT.BLOCK, 'acme')]);

    expect(engine.evaluate({ action: 'file.write' }, context).effect).toBe(
      DECISION_EFFECT.ALLOW,
    );
  });
});
