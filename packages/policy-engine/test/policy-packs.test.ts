import { describe, expect, it } from 'vitest';
import { DECISION_EFFECT } from '@memnox/core';
import {
  findPolicyPack,
  mergePolicies,
  PACK_MATURITY,
  POLICY_PACKS,
  POLICY_SURFACES,
} from '../src/policy-packs';
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

  // A catalogue draws itself from these, so a pack missing one lands nowhere.
  it('files every pack under a declared surface, titled and versioned', () => {
    const surfaces = new Set<string>(POLICY_SURFACES.map((surface) => surface.id));

    for (const pack of POLICY_PACKS) {
      expect(surfaces.has(pack.surface), `${pack.name} surface`).toBe(true);
      expect(pack.label.length, `${pack.name} label`).toBeGreaterThan(0);
      expect(pack.version, `${pack.name} version`).toMatch(/^\d+\.\d+\.\d+$/);
      expect(Object.values(PACK_MATURITY) as string[], `${pack.name} maturity`).toContain(
        pack.maturity,
      );
    }
  });

  it('names each pack once, so an install path cannot be ambiguous', () => {
    const names = POLICY_PACKS.map((pack) => pack.name);
    expect(new Set(names).size).toBe(names.length);

    const surfaceIds = POLICY_SURFACES.map((surface) => surface.id);
    expect(new Set(surfaceIds).size).toBe(surfaceIds.length);
  });

  // Otherwise a surface renders as an empty heading in every catalogue drawing it.
  it('leaves no surface without a pack in it', () => {
    const used = new Set<string>(POLICY_PACKS.map((pack) => pack.surface));
    const empty = POLICY_SURFACES.filter((surface) => !used.has(surface.id));

    expect(empty.map((surface) => surface.id)).toEqual([]);
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
