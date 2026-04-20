import { describe, expect, it } from 'vitest';
import { DECISION_EFFECT } from '@memnox/core';
import { findPolicyPack, mergePolicies, POLICY_PACKS } from '../src/policy-packs';
import { validatePolicyDocument } from '../src/policy-validator';
import { POLICY_DOCUMENT_VERSION } from '../src/policy';
import type { Policy } from '../src/policy';

describe('shipped policy packs', () => {
  it('every pack validates as a real policy document', () => {
    for (const pack of POLICY_PACKS) {
      expect(() =>
        validatePolicyDocument({
          version: POLICY_DOCUMENT_VERSION,
          policies: pack.policies,
        }),
      ).not.toThrow();
    }
  });

  it('uses globally unique policy names, so packs compose', () => {
    const names = POLICY_PACKS.flatMap((pack) => pack.policies.map((p) => p.name));
    expect(new Set(names).size).toBe(names.length);
  });

  it('finds a pack by name and reports an unknown one as null', () => {
    expect(findPolicyPack('payments')?.policies.length).toBeGreaterThan(0);
    expect(findPolicyPack('does-not-exist')).toBeNull();
  });
});

describe('mergePolicies', () => {
  const existing: Policy[] = [
    {
      name: 'payment-code-approval',
      match: { actions: ['code.modify'] },
      decision: { effect: DECISION_EFFECT.BLOCK },
    },
  ];

  it('never redefines a policy the team already owns', () => {
    const pack = findPolicyPack('payments');
    const merged = mergePolicies(existing, pack?.policies ?? []);

    expect(merged.skipped).toContain('payment-code-approval');
    expect(merged.added).not.toContain('payment-code-approval');
    expect(
      merged.policies.find((p) => p.name === 'payment-code-approval')?.decision.effect,
    ).toBe(DECISION_EFFECT.BLOCK);
  });

  it('appends the policies that are genuinely new', () => {
    const pack = findPolicyPack('production-safety');
    const merged = mergePolicies(existing, pack?.policies ?? []);

    expect(merged.added).toContain('production-database-protection');
    expect(merged.policies).toHaveLength(existing.length + merged.added.length);
  });

  it('is a no-op when installing the same pack twice', () => {
    const pack = findPolicyPack('data-privacy');
    const once = mergePolicies([], pack?.policies ?? []);
    const twice = mergePolicies(once.policies, pack?.policies ?? []);

    expect(twice.added).toEqual([]);
    expect(twice.policies).toHaveLength(once.policies.length);
  });
});
