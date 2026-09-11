import { describe, expect, it } from 'vitest';
import { DECISION_EFFECT } from '@memnox/core';
import { PolicyEngine } from '../src/policy/policy-engine';
import { matchesAny } from '../src/policy/pattern-matcher';
import type { Policy } from '../src/policy/policy';

/**
 * The index may narrow the work and may never narrow the answer.
 *
 * `candidates()` buckets rules by the first literal segment of their action
 * patterns and scans only that bucket plus the unindexed ones. That is a
 * performance decision sitting directly under a security one: a rule the bucket
 * lookup fails to return is a rule that never gets to deny anything, and the
 * failure is silent. Nothing throws, nothing is logged, and the verdict is
 * `no_policy_matched` — which is the default effect, which is allow.
 *
 * `policy-index.test.ts` beside this checks the cases somebody thought of. This
 * checks the invariant over every combination of a corpus built to break it:
 * wildcards in the first segment and after it, patterns with no separator at
 * all, mixed case, empty segments, and the regex metacharacters the compiler has
 * to escape rather than honour.
 *
 * The comparison is against `matchesAny`, which is what `matches()` reduces to
 * when a rule constrains nothing but the action. That is the ground truth the
 * index has to reproduce exactly: not a second implementation of matching, but
 * the same matcher asked without the bucket in the way.
 */

/** Patterns chosen so that some index under a prefix and some cannot. */
const PATTERNS = [
  'git.push',
  'git.*',
  'git',
  '*',
  '**',
  '*.push',
  'g*t.push',
  'git.push.force',
  'a.b.c',
  'a.*.c',
  'GIT.PUSH',
  'Git.Push',
  'git.',
  '.git',
  '',
  // Regex metacharacters: the compiler escapes these, so they are literals.
  'git+push',
  'git(push)',
  'a[b]c',
  'a|b',
  'a$b',
  '^ab',
  'a.b?',
  'a\\b',
];

/** Actions chosen to sit on the boundaries those patterns draw. */
const ACTIONS = [
  'git.push',
  'GIT.PUSH',
  'Git.Push',
  'git.push.force',
  'git.pushx',
  'git',
  'gits',
  'gt.push',
  'grafana.push',
  'a.b.c',
  'a.x.c',
  'a.c',
  'git.',
  '.git',
  'git+push',
  'git(push)',
  'a[b]c',
  'a|b',
  'a$b',
  '^ab',
  'a.b?',
  'a\\b',
  'unrelated.action',
];

const rule = (name: string, actions: string[]): Policy => ({
  name,
  match: { actions },
  decision: { effect: DECISION_EFFECT.DENY, reason: name },
});

/** Every pattern as its own rule, so a miss names the pattern that went missing. */
const POLICIES = PATTERNS.map((pattern, index) =>
  rule(`rule-${String(index)}:${pattern}`, [pattern]),
);

describe('the action index narrows the work and never the answer', () => {
  const engine = new PolicyEngine(POLICIES);

  it.each(ACTIONS)('finds every rule that matches %s', (action) => {
    /* What the matcher says, with no bucket in the way. A rule constraining
       nothing but the action matches exactly when its patterns do. */
    const shouldMatch = POLICIES.filter((policy) =>
      matchesAny(policy.match.actions, action),
    )
      .map((policy) => policy.name)
      .sort();

    const found = engine
      .evaluate({ action }, { agentName: 'claude-code' })
      .matchedPolicies.map((policy) => policy.name)
      .sort();

    expect(found).toEqual(shouldMatch);
  });

  /* A rule that declares several patterns has to be reachable through each of
     them, or it denies on Monday's action name and not on Tuesday's. */
  it.each(ACTIONS)('finds a multi-pattern rule through any of them for %s', (action) => {
    const combined = rule('combined', [...PATTERNS]);
    const one = new PolicyEngine([combined]);

    const shouldMatch = matchesAny(combined.match.actions, action);
    const found = one.evaluate({ action }, { agentName: 'claude-code' }).matchedPolicies
      .length;

    expect(found > 0).toBe(shouldMatch);
  });

  /**
   * The whole point, stated as the outcome rather than as the mechanism: a deny
   * that the matcher agrees with must never come back as "no policy matched",
   * because that answers with the default effect and the default effect allows.
   */
  it.each(ACTIONS)('never answers allow-by-default where a deny matches %s', (action) => {
    const anyDenyMatches = POLICIES.some((policy) =>
      matchesAny(policy.match.actions, action),
    );
    if (!anyDenyMatches) return;

    expect(engine.evaluate({ action }, { agentName: 'claude-code' }).effect).toBe(
      DECISION_EFFECT.DENY,
    );
  });
});
