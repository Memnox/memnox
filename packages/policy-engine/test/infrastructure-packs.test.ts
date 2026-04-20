import { describe, expect, it } from 'vitest';
import { DECISION_EFFECT, type DecisionEffect } from '@memnox/core';
import { PolicyEngine } from '../src/policy-engine';
import { findPolicyPack } from '../src/policy-packs';
import type { Policy } from '../src/policy';

const AGENT = { agentName: 'claude-code' };

function packEngine(name: string): PolicyEngine {
  const pack = findPolicyPack(name);
  if (pack === null) throw new Error(`pack "${name}" is not shipped`);
  return new PolicyEngine(pack.policies as Policy[]);
}

const decide = (
  engine: PolicyEngine,
  action: string,
  extra: { target?: string; environment?: string } = {},
): DecisionEffect => engine.evaluate({ action, ...extra }, AGENT).effect;

describe('repository-protection', () => {
  const engine = packEngine('repository-protection');

  it('blocks history rewrites outright', () => {
    expect(decide(engine, 'repository.force_push')).toBe(DECISION_EFFECT.BLOCK);
    expect(decide(engine, 'repository.reset_hard')).toBe(DECISION_EFFECT.BLOCK);
  });

  it('escalates branch deletion rather than blocking it', () => {
    expect(decide(engine, 'repository.delete_branch')).toBe(
      DECISION_EFFECT.REQUIRE_APPROVAL,
    );
  });

  it('leaves ordinary repository work alone', () => {
    expect(decide(engine, 'repository.read')).toBe(DECISION_EFFECT.ALLOW);
    expect(decide(engine, 'repository.commit')).toBe(DECISION_EFFECT.ALLOW);
  });
});

describe('infrastructure', () => {
  const engine = packEngine('infrastructure');

  it('blocks terraform state destruction', () => {
    expect(decide(engine, 'terraform.destroy')).toBe(DECISION_EFFECT.BLOCK);
    expect(decide(engine, 'terraform.state_remove')).toBe(DECISION_EFFECT.BLOCK);
  });

  it('escalates disruptive cluster and cloud operations', () => {
    expect(decide(engine, 'kubernetes.drain')).toBe(DECISION_EFFECT.REQUIRE_APPROVAL);
    expect(decide(engine, 'cloud.delete_bucket')).toBe(DECISION_EFFECT.REQUIRE_APPROVAL);
    expect(decide(engine, 'cloud.modify_iam')).toBe(DECISION_EFFECT.REQUIRE_APPROVAL);
  });

  it('routes permission changes to security, not the platform team', () => {
    const matched = engine.evaluate(
      { action: 'cloud.modify_iam' },
      AGENT,
    ).matchedPolicies;
    expect(matched[0]?.approvers).toEqual(['security-team']);
  });

  it('leaves reads and plans alone', () => {
    expect(decide(engine, 'terraform.plan')).toBe(DECISION_EFFECT.ALLOW);
    expect(decide(engine, 'kubernetes.get')).toBe(DECISION_EFFECT.ALLOW);
  });
});

describe('framework-db-reset', () => {
  const engine = packEngine('framework-db-reset');

  it('escalates a schema reset outside production', () => {
    expect(decide(engine, 'database.migrate_reset', { environment: 'staging' })).toBe(
      DECISION_EFFECT.REQUIRE_APPROVAL,
    );
  });

  // Two policies match in production; the most restrictive must win.
  it('blocks outright in production, where approval is not enough', () => {
    expect(decide(engine, 'database.migrate_reset', { environment: 'production' })).toBe(
      DECISION_EFFECT.BLOCK,
    );
  });

  it('leaves a forward migration alone', () => {
    expect(decide(engine, 'database.migrate', { environment: 'production' })).toBe(
      DECISION_EFFECT.ALLOW,
    );
  });
});

describe('read-only-production', () => {
  const engine = packEngine('read-only-production');

  it('freezes writes in production', () => {
    expect(decide(engine, 'database.write', { environment: 'production' })).toBe(
      DECISION_EFFECT.BLOCK,
    );
    expect(decide(engine, 'database.alter', { environment: 'prod' })).toBe(
      DECISION_EFFECT.BLOCK,
    );
  });

  it('still allows reads in production', () => {
    expect(decide(engine, 'database.read', { environment: 'production' })).toBe(
      DECISION_EFFECT.ALLOW,
    );
  });

  it('does not freeze other environments', () => {
    expect(decide(engine, 'database.write', { environment: 'staging' })).toBe(
      DECISION_EFFECT.ALLOW,
    );
  });
});

describe('policy-bypass-protection', () => {
  const engine = packEngine('policy-bypass-protection');

  // The pack exists for exactly this: an agent must not disarm its own governor.
  it('blocks writes to the policy file and hook config', () => {
    expect(decide(engine, 'file.write', { target: 'memnox.policies.yaml' })).toBe(
      DECISION_EFFECT.BLOCK,
    );
    expect(decide(engine, 'file.delete', { target: '.memnox/agents.json' })).toBe(
      DECISION_EFFECT.BLOCK,
    );
    expect(
      decide(engine, 'file.write', { target: '/home/dev/.claude/settings.json' }),
    ).toBe(DECISION_EFFECT.BLOCK);
  });

  it('leaves ordinary source files alone', () => {
    expect(decide(engine, 'file.write', { target: 'src/index.ts' })).toBe(
      DECISION_EFFECT.ALLOW,
    );
  });
});

describe('agent-delegation', () => {
  const engine = packEngine('agent-delegation');

  it('escalates spawning a subagent', () => {
    expect(decide(engine, 'agent.delegate')).toBe(DECISION_EFFECT.REQUIRE_APPROVAL);
    expect(decide(engine, 'agent.spawn')).toBe(DECISION_EFFECT.REQUIRE_APPROVAL);
  });
});
