import { describe, expect, it } from 'vitest';
import { DECISION_EFFECT } from '@memnox/core';
import { POLICY_VERSION_LENGTH, versionPolicySet } from '../src/policy-version';
import type { Policy } from '../src/policy';

const FIRST: Policy = {
  name: 'a-policy',
  match: { actions: ['database.delete'] },
  decision: { effect: DECISION_EFFECT.WITHHOLD },
};

const SECOND: Policy = {
  name: 'b-policy',
  match: { actions: ['deploy.service'] },
  decision: { effect: DECISION_EFFECT.ESCALATE },
};

describe('versionPolicySet', () => {
  it('is stable across reordering — the file layout is not the rule set', () => {
    expect(versionPolicySet([FIRST, SECOND]).version).toBe(
      versionPolicySet([SECOND, FIRST]).version,
    );
  });

  it('changes when any rule changes', () => {
    const loosened: Policy = {
      ...FIRST,
      decision: { effect: DECISION_EFFECT.ESCALATE },
    };
    expect(versionPolicySet([FIRST]).version).not.toBe(
      versionPolicySet([loosened]).version,
    );
  });

  it('changes when a rule is added', () => {
    expect(versionPolicySet([FIRST]).version).not.toBe(
      versionPolicySet([FIRST, SECOND]).version,
    );
  });

  it('summarises the set for a reviewer', () => {
    const summary = versionPolicySet([SECOND, FIRST]);
    expect(summary.policyCount).toBe(2);
    expect(summary.policyNames).toEqual(['a-policy', 'b-policy']);
    expect(summary.version).toHaveLength(POLICY_VERSION_LENGTH);
  });

  it('handles an empty set without throwing', () => {
    expect(versionPolicySet([]).policyCount).toBe(0);
  });
});
