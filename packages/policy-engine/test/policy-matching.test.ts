import { describe, expect, it } from 'vitest';
import { DECISION_EFFECT } from '@memnox/core';
import { PolicyEngine, type Policy } from '../src/index';

const AGENT = { agentName: 'claude-code', now: new Date('2026-08-07T12:00:00Z') };

function engine(...policies: Policy[]): PolicyEngine {
  return new PolicyEngine(policies);
}

const rule = (over: Partial<Policy> & Pick<Policy, 'name' | 'match'>): Policy => ({
  decision: { effect: DECISION_EFFECT.WITHHOLD, reason: over.name },
  ...over,
});

describe('argument matching', () => {
  const noRecursiveDelete = rule({
    name: 'no-rm-rf',
    match: { actions: ['mcp.*'], arguments: { command: ['*rm -rf*'] } },
  });

  it('blocks a call whose named argument matches the pattern', () => {
    const result = engine(noRecursiveDelete).evaluate(
      { action: 'mcp.run_shell', arguments: { command: 'sudo rm -rf /var' } },
      AGENT,
    );

    expect(result.effect).toBe(DECISION_EFFECT.WITHHOLD);
  });

  it('leaves the same tool alone when the argument does not match', () => {
    const result = engine(noRecursiveDelete).evaluate(
      { action: 'mcp.run_shell', arguments: { command: 'ls -la' } },
      AGENT,
    );

    expect(result.effect).toBe(DECISION_EFFECT.ALLOW);
  });

  it('does not fire when the call carries no arguments at all', () => {
    const result = engine(noRecursiveDelete).evaluate({ action: 'mcp.run_shell' }, AGENT);

    expect(result.effect).toBe(DECISION_EFFECT.ALLOW);
  });

  it('narrows with each named argument — every one must match', () => {
    const scoped = rule({
      name: 'no-force-push-on-release',
      match: {
        actions: ['shell.execute'],
        arguments: { command: ['*git push*--force*'], cwd: ['/srv/*'] },
      },
    });

    const inScope = engine(scoped).evaluate(
      {
        action: 'shell.execute',
        arguments: { command: 'git push --force', cwd: '/srv/checkout' },
      },
      AGENT,
    );
    const elsewhere = engine(scoped).evaluate(
      {
        action: 'shell.execute',
        arguments: { command: 'git push --force', cwd: '/tmp/scratch' },
      },
      AGENT,
    );

    expect(inScope.effect).toBe(DECISION_EFFECT.WITHHOLD);
    expect(elsewhere.effect).toBe(DECISION_EFFECT.ALLOW);
  });

  it('matches a path argument, which is how a .env write is caught', () => {
    const envFiles = rule({
      name: 'no-env-writes',
      match: { actions: ['file.write'], arguments: { file_path: ['*.env', '*.env.*'] } },
    });

    expect(
      engine(envFiles).evaluate(
        { action: 'file.write', arguments: { file_path: 'services/api/.env' } },
        AGENT,
      ).effect,
    ).toBe(DECISION_EFFECT.WITHHOLD);
  });
});

describe('working directory and branch matching', () => {
  it('applies a rule only inside the directories it names', () => {
    const engineUnderTest = engine(
      rule({
        name: 'payments-are-sensitive',
        match: { actions: ['file.write'], workingDirectories: ['/srv/payments*'] },
      }),
    );

    expect(
      engineUnderTest.evaluate(
        { action: 'file.write', workingDirectory: '/srv/payments/api' },
        AGENT,
      ).effect,
    ).toBe(DECISION_EFFECT.WITHHOLD);
    expect(
      engineUnderTest.evaluate(
        { action: 'file.write', workingDirectory: '/srv/marketing' },
        AGENT,
      ).effect,
    ).toBe(DECISION_EFFECT.ALLOW);
  });

  it('applies a rule only on the branches it names', () => {
    const engineUnderTest = engine(
      rule({
        name: 'release-branches-need-a-human',
        match: { actions: ['shell.execute'], branches: ['main', 'release/*'] },
        decision: { effect: DECISION_EFFECT.ESCALATE, approvers: ['eng-lead'] },
      }),
    );

    expect(
      engineUnderTest.evaluate({ action: 'shell.execute', branch: 'release/24.3' }, AGENT)
        .effect,
    ).toBe(DECISION_EFFECT.ESCALATE);
    expect(
      engineUnderTest.evaluate({ action: 'shell.execute', branch: 'spike/idea' }, AGENT)
        .effect,
    ).toBe(DECISION_EFFECT.ALLOW);
  });
});

describe('per-rule monitor mode', () => {
  const observed = rule({
    name: 'candidate-rule',
    match: { actions: ['deploy.*'] },
    decision: { effect: DECISION_EFFECT.WITHHOLD, mode: 'observe', reason: 'candidate' },
  });

  it('records what it would have done without applying it', () => {
    const result = engine(observed).evaluate({ action: 'deploy.service' }, AGENT);

    expect(result.effect).toBe(DECISION_EFFECT.ALLOW);
    expect(result.shadowEffect).toBe(DECISION_EFFECT.WITHHOLD);
    expect(result.matchedPolicies[0]?.observed).toBe(true);
  });

  it('never softens what an enforcing rule decided', () => {
    const result = engine(
      observed,
      rule({
        name: 'enforced-approval',
        match: { actions: ['deploy.*'] },
        decision: { effect: DECISION_EFFECT.ESCALATE, approvers: ['eng-lead'] },
      }),
    ).evaluate({ action: 'deploy.service' }, AGENT);

    expect(result.effect).toBe(DECISION_EFFECT.ESCALATE);
    expect(result.shadowEffect).toBe(DECISION_EFFECT.WITHHOLD);
  });

  it('reports no withheld effect when monitoring is no stricter than the verdict', () => {
    const result = engine(
      rule({
        name: 'observed-allow',
        match: { actions: ['deploy.*'] },
        decision: { effect: DECISION_EFFECT.ALLOW, mode: 'observe' },
      }),
    ).evaluate({ action: 'deploy.service' }, AGENT);

    expect(result.shadowEffect).toBeUndefined();
  });
});

describe('rate limit carried to the gateway', () => {
  it('exposes the ceiling on the matched policy without counting anything', () => {
    const result = engine(
      rule({
        name: 'ten-deploys-an-hour',
        match: { actions: ['deploy.*'] },
        decision: {
          effect: DECISION_EFFECT.ALLOW,
          rateLimit: { max: 10, windowSeconds: 3600 },
        },
      }),
    ).evaluate({ action: 'deploy.service' }, AGENT);

    expect(result.effect).toBe(DECISION_EFFECT.ALLOW);
    expect(result.matchedPolicies[0]?.rateLimit).toEqual({
      max: 10,
      windowSeconds: 3600,
    });
  });
});

describe('redact as an effect', () => {
  it('ranks below approval and above allow, so approval still wins', () => {
    const result = engine(
      rule({
        name: 'mask-it',
        match: { actions: ['mcp.*'] },
        decision: { effect: DECISION_EFFECT.ESCALATE },
      }),
      rule({
        name: 'ask-a-human',
        match: { actions: ['mcp.*'] },
        decision: { effect: DECISION_EFFECT.ESCALATE, approvers: ['eng-lead'] },
      }),
    ).evaluate({ action: 'mcp.send_message' }, AGENT);

    expect(result.effect).toBe(DECISION_EFFECT.ESCALATE);
  });
});
