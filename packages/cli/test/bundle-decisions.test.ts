import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DECISION_EFFECT, LocalGate, loadPoliciesFromFile } from '@memnox/core';

import {
  applyBundle,
  documentFrom,
  orgPolicyPath,
  PULL_OUTCOME,
  type Bundle,
  type BundleDecision,
  type BundleRule,
} from '../src/sync/bundle';

/**
 * A published rule's decision reaches the gate whole. The team copy used to keep the effect
 * and nothing beside it, so a rule set to observe was enforced on every machine and an ask
 * lost who may approve it. Where this gate cannot enforce a field, it reads the rule strictly.
 */

/** One rule on `deploy.run`, as the control plane sends it to a runtime that reads `decision`. */
function deployRule(
  decision: BundleDecision,
  effect: string = decision.effect,
): BundleRule {
  return {
    id: 'deploys',
    policyHash: 'p1',
    line: 1,
    domain: 'deploy',
    effect,
    specificity: 10,
    match: 'deploy.run',
    reason: 'nobody is on call to watch it.',
    decision,
  };
}

const bundleOf = (rules: BundleRule[]): Bundle => ({
  hash: 'h1',
  policies: [],
  rules,
  conditions: [],
  tags: [],
});

interface Written {
  policies: { name: string; decision: Record<string, unknown> }[];
}

const written = (rule: BundleRule): Written => documentFrom(bundleOf([rule])) as Written;

describe('a published rule reaches the gate with its whole decision', () => {
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'memnox-bundle-decisions-'));
  });
  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  async function gateFor(rule: BundleRule): Promise<LocalGate> {
    const result = await applyBundle(home, bundleOf([rule]));
    expect(result.outcome).toBe(PULL_OUTCOME.APPLIED);
    return new LocalGate(await loadPoliciesFromFile(orgPolicyPath(home)), {
      agentName: 'claude-code',
    });
  }

  it('keeps an observed rule observed: it is recorded and decides nothing', async () => {
    // Sent under the spelling an older runtime skips, as the control plane does for observe.
    const rule = {
      ...deployRule({ effect: DECISION_EFFECT.DENY, mode: 'observe' }),
      match: 'memnox.requires-rule-decisions',
      actions: ['deploy.run'],
    };

    const verdict = (await gateFor(rule)).evaluate({ action: 'deploy.run' });

    expect(verdict.effect).toBe(DECISION_EFFECT.ALLOW);
    expect(verdict.shadowEffect).toBe(DECISION_EFFECT.DENY);
    expect(verdict.matchedPolicies[0]?.observed).toBe(true);
  });

  it('keeps approvers and the quorum on the rule the gate holds', async () => {
    const rule = deployRule(
      { effect: DECISION_EFFECT.ASK, approvers: ['dba', 'sre-lead'], minApprovals: 2 },
      DECISION_EFFECT.DENY,
    );

    await applyBundle(home, bundleOf([rule]));
    const [policy] = await loadPoliciesFromFile(orgPolicyPath(home));

    expect(policy?.decision.approvers).toEqual(['dba', 'sre-lead']);
    expect(policy?.decision.minApprovals).toBe(2);
  });

  it('keeps a rate limit on the rule the gate holds', async () => {
    const rule = deployRule({
      effect: DECISION_EFFECT.DENY,
      rateLimit: { max: 5, windowSeconds: 60 },
    });

    const verdict = (await gateFor(rule)).evaluate({ action: 'deploy.run' });

    expect(verdict.effect).toBe(DECISION_EFFECT.DENY);
    expect(verdict.matchedPolicies[0]?.rateLimit).toEqual({ max: 5, windowSeconds: 60 });
  });

  it('keeps the whole alternative the rule was published with', () => {
    const alternative = {
      action: 'deploy.staging',
      note: 'ship to staging first',
      resource: 'staging',
    };
    const rule = {
      ...deployRule({ effect: DECISION_EFFECT.DENY, alternative }),
      alternative: 'deploy.staging',
    };

    expect(written(rule).policies[0]?.decision['alternative']).toEqual(alternative);
  });

  it('writes a rule with no decision exactly as it always did', () => {
    const { decision: _dropped, ...plain } = deployRule({ effect: DECISION_EFFECT.ASK });

    expect(written(plain).policies[0]?.decision).toEqual({
      effect: DECISION_EFFECT.ASK,
      reason: 'nobody is on call to watch it.',
    });
  });
});

describe('a decision this gate cannot enforce never makes a rule more permissive', () => {
  // An ask anybody could answer is wider than one only the named approvers may, so it is refused.
  it('refuses an ask held to named approvers, and says who may approve it', () => {
    const [policy] = written(
      deployRule({ effect: DECISION_EFFECT.ASK, approvers: ['dba'] }),
    ).policies;

    expect(policy?.decision['effect']).toBe(DECISION_EFFECT.DENY);
    expect(policy?.decision['reason']).toContain('only dba may approve it');
    expect(policy?.decision['approvers']).toEqual(['dba']);
  });

  const cases: readonly [string, BundleDecision, string | null][] = [
    ['an ask needing two approvals', { effect: 'ask', minApprovals: 2 }, 'deny'],
    [
      'a rate limited ask',
      { effect: 'ask', rateLimit: { max: 1, windowSeconds: 60 } },
      'deny',
    ],
    [
      'a rate limited allow',
      { effect: 'allow', rateLimit: { max: 1, windowSeconds: 60 } },
      null,
    ],
    [
      'an ask with a field this gate does not know',
      { effect: 'ask', requires: ['t'] },
      'deny',
    ],
    [
      'an allow with a field this gate does not know',
      { effect: 'allow', expiresAt: 1 },
      null,
    ],
    [
      'a deny with a field this gate does not know',
      { effect: 'deny', expiresAt: 1 },
      'deny',
    ],
    [
      'an ask with a mode this gate does not know',
      { effect: 'ask', mode: 'shadow' },
      'deny',
    ],
    [
      'an ask with approvers that are not names',
      { effect: 'ask', approvers: 'dba' },
      'deny',
    ],
    [
      'a decision that would not read',
      { effect: 'ask', unreadableDecision: true },
      'deny',
    ],
  ];

  for (const [what, decision, effect] of cases) {
    it(`writes ${what} as ${effect ?? 'no rule at all'}`, async () => {
      const document = written(deployRule(decision));

      if (effect === null) expect(document.policies).toEqual([]);
      else expect(document.policies[0]?.decision['effect']).toBe(effect);

      // Whatever it wrote, the gate's own loader accepts, so one odd rule never refuses a bundle.
      const home = await mkdtemp(join(tmpdir(), 'memnox-bundle-decisions-'));
      try {
        const result = await applyBundle(home, bundleOf([deployRule(decision)]));
        expect(result.outcome).toBe(PULL_OUTCOME.APPLIED);
      } finally {
        await rm(home, { recursive: true, force: true });
      }
    });
  }

  it('takes the published effect from the decision over the one an older runtime is sent', () => {
    const rule = deployRule({ effect: DECISION_EFFECT.ASK, mode: 'observe' }, 'deny');

    expect(written(rule).policies[0]?.decision).toMatchObject({
      effect: DECISION_EFFECT.ASK,
      mode: 'observe',
    });
  });

  it('leaves a decision that restricts nothing as the ask it was published as', () => {
    const rule = deployRule({
      effect: DECISION_EFFECT.ASK,
      mode: 'enforce',
      approvers: [],
      minApprovals: 1,
    });

    expect(written(rule).policies[0]?.decision['effect']).toBe(DECISION_EFFECT.ASK);
  });
});
