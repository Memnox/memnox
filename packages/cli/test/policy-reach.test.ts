import { describe, expect, it } from 'vitest';
import { isEmptyReach, policyReach, reachBeyond } from '../src/policy-reach';
import { SAFETY_CASES, SAFETY_EXPECTATION, meetsExpectation } from '../src/safety-cases';
import { DECISION_EFFECT } from '@memnox/core';

const POLICIES = [
  {
    name: 'production-database-protection',
    match: {
      actions: ['database.delete', 'database.drop'],
      targets: ['*users*'],
      environments: ['production'],
    },
  },
  { name: 'shape-free-rule' },
  'not a policy at all',
];

describe('policy reach', () => {
  it('reads the patterns a named rule matches on', () => {
    expect(policyReach(POLICIES, 'production-database-protection')).toEqual({
      actions: ['database.delete', 'database.drop'],
      targets: ['*users*'],
      environments: ['production'],
    });
  });

  it('returns null for a rule the runtime did not hand back', () => {
    expect(policyReach(POLICIES, 'not-in-the-set')).toBeNull();
  });

  it('survives a policy with no match block and a non-object entry', () => {
    expect(policyReach(POLICIES, 'shape-free-rule')).toEqual({
      actions: [],
      targets: [],
      environments: [],
    });
  });

  it('drops what the reader already asked about', () => {
    const reach = policyReach(POLICIES, 'production-database-protection');
    expect(reach).not.toBeNull();

    const beyond = reachBeyond(reach!, {
      action: 'database.delete',
      environment: 'production',
    });

    expect(beyond).toEqual({
      actions: ['database.drop'],
      targets: ['*users*'],
      environments: [],
    });
  });

  it('calls a reach that adds nothing empty', () => {
    expect(isEmptyReach({ actions: [], targets: [], environments: [] })).toBe(true);
  });
});

describe('safety cases', () => {
  it('carries a control case, so a suite that stops everything still fails it', () => {
    const controls = SAFETY_CASES.filter(
      (safetyCase) => safetyCase.expect === SAFETY_EXPECTATION.ALLOW,
    );

    expect(controls.length).toBeGreaterThan(0);
    for (const control of controls) {
      expect(meetsExpectation(control, DECISION_EFFECT.WITHHOLD)).toBe(false);
      expect(meetsExpectation(control, DECISION_EFFECT.ALLOW)).toBe(true);
    }
  });

  it('treats an escalated action as stopped and an allow as proceeding', () => {
    const dangerous = SAFETY_CASES.find(
      (safetyCase) => safetyCase.expect === SAFETY_EXPECTATION.STOP,
    );
    expect(dangerous).toBeDefined();

    expect(meetsExpectation(dangerous!, DECISION_EFFECT.ESCALATE)).toBe(true);
    expect(meetsExpectation(dangerous!, DECISION_EFFECT.ALLOW)).toBe(false);
  });

  it('gives every case a distinct id', () => {
    const ids = SAFETY_CASES.map((safetyCase) => safetyCase.id);

    expect(new Set(ids).size).toBe(ids.length);
  });
});
