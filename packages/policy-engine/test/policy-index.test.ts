import { describe, expect, it } from 'vitest';
import { DECISION_EFFECT } from '@memnox/core';
import { PolicyEngine } from '../src/policy-engine';
import type { Policy } from '../src/policy';

const AGENT = { agentName: 'claude-code' };

const rule = (name: string, actions: string[]): Policy => ({
  name,
  match: { actions },
  decision: { effect: DECISION_EFFECT.REQUIRE_APPROVAL },
});

/** What a scan of every policy would match — the index must agree exactly. */
function unindexedMatches(policies: Policy[], action: string): string[] {
  return policies
    .filter(
      (policy) =>
        new PolicyEngine([policy]).evaluate({ action }, AGENT).matchedPolicies.length > 0,
    )
    .map((policy) => policy.name)
    .sort();
}

const POLICIES: Policy[] = [
  rule('exact', ['database.delete']),
  rule('prefix-wildcard', ['database.*']),
  rule('leading-wildcard', ['*.delete']),
  rule('any', ['*']),
  rule('other-family', ['shell.execute']),
  rule('multi', ['deploy.service', 'database.drop']),
  rule('mid-wildcard', ['data*.delete']),
  rule('cased', ['Database.Delete']),
];

describe('action-prefix index', () => {
  const engine = new PolicyEngine(POLICIES);

  const matched = (action: string): string[] =>
    engine
      .evaluate({ action }, AGENT)
      .matchedPolicies.map((policy) => policy.name)
      .sort();

  // The index may only narrow work, never the result.
  it.each([
    'database.delete',
    'database.drop',
    'shell.execute',
    'deploy.service',
    'unknown.action',
    'DATABASE.DELETE',
    'database',
  ])('agrees with a full scan for %s', (action) => {
    expect(matched(action)).toEqual(unindexedMatches(POLICIES, action));
  });

  it('still matches a wildcard-first pattern that no bucket holds', () => {
    expect(matched('anything.delete')).toContain('leading-wildcard');
    expect(matched('anything.delete')).toContain('any');
  });

  it('matches case-insensitively across the bucket boundary', () => {
    expect(matched('database.delete')).toContain('cased');
  });

  it('indexes every prefix a multi-pattern rule declares', () => {
    expect(matched('deploy.service')).toContain('multi');
    expect(matched('database.drop')).toContain('multi');
  });

  it('finds only catch-all rules for an unrelated action', () => {
    expect(matched('unknown.action')).toEqual(['any']);
  });

  it('reports the same rule set it was given', () => {
    expect(engine.rules()).toHaveLength(POLICIES.length);
  });
});
