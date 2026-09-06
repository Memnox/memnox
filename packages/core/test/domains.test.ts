import { describe, expect, it } from 'vitest';
import {
  DOMAIN_CHOICES,
  POLICY_DOMAIN,
  policiesFrom,
  recommendedAnswers,
  type PolicyDomain,
} from '../src/policy/domains';
import {
  DECISION_EFFECT,
  type DecisionEffect,
} from '../src/constants/decision.constants';
import { TOOL_CLASS } from '../src/discovery/classify';
import { verbAction, verbTableFor } from '../src/verbs/index';

describe('the five domains somebody decides about', () => {
  it('covers each one exactly once', () => {
    const named = DOMAIN_CHOICES.map((choice) => choice.domain).sort();
    expect(named).toEqual([...Object.values(POLICY_DOMAIN)].sort());
  });

  it('says why each recommendation is not stricter', () => {
    for (const choice of DOMAIN_CHOICES) {
      expect(choice.because.length).toBeGreaterThan(20);
      expect(choice.question.length).toBeGreaterThan(10);
    }
  });

  it('recommends denying credential reads and asking about the rest', () => {
    const answers = recommendedAnswers();
    expect(answers.get(POLICY_DOMAIN.FILESYSTEM)).toBe(DECISION_EFFECT.DENY);
    expect(answers.get(POLICY_DOMAIN.GIT)).toBe(DECISION_EFFECT.DENY);
    expect(answers.get(POLICY_DOMAIN.NETWORK)).toBe(DECISION_EFFECT.ASK);
  });

  it('never recommends denying every unknown host, which breaks ordinary work', () => {
    const network = DOMAIN_CHOICES.find((c) => c.domain === POLICY_DOMAIN.NETWORK);
    expect(network?.recommended).not.toBe(DECISION_EFFECT.DENY);
    expect(network?.because).toContain('breaks ordinary work');
  });
});

describe('turning answers into rules', () => {
  it('writes one rule per domain that was not left on allow', () => {
    const policies = policiesFrom(recommendedAnswers());
    expect(policies).toHaveLength(5);
    expect(policies.every((policy) => policy.decision.effect !== 'allow')).toBe(true);
  });

  it('writes nothing for a domain somebody chose to allow', () => {
    const answers = new Map<PolicyDomain, DecisionEffect>([
      [POLICY_DOMAIN.FILESYSTEM, DECISION_EFFECT.ALLOW],
      [POLICY_DOMAIN.GIT, DECISION_EFFECT.DENY],
    ]);
    expect(policiesFrom(answers).map((each) => each.name)).toEqual(['git-deny']);
  });

  it('gives every rule an alternative, so no refusal is a dead end', () => {
    for (const policy of policiesFrom(recommendedAnswers())) {
      expect(policy.decision.alternative?.action.length).toBeGreaterThan(0);
    }
  });

  it('says the rule came from a choice somebody made, not from us', () => {
    const [policy] = policiesFrom(recommendedAnswers());
    expect(policy?.decision.reason).toContain('you chose');
  });

  it('scopes the credential rule to credential paths, not the whole disk', () => {
    const policy = policiesFrom(recommendedAnswers()).find((each) =>
      each.name.startsWith('filesystem'),
    );
    expect(policy?.match.targets).toContain('**/.ssh/**');
    expect(policy?.match.targets).not.toContain('**');
  });
});

describe('the baseline denies what it says it denies', () => {
  /* This read `git.push` once, so the generated baseline denied every ordinary push
     and permitted `git push --force`. Both halves were wrong and neither was visible
     until something rendered the boundary one action at a time. */
  const git = DOMAIN_CHOICES.find((choice) => choice.domain === POLICY_DOMAIN.GIT);

  it('names every destructive git action the verb table produces', () => {
    const table = verbTableFor('git');
    const destructive = (table?.verbs ?? [])
      .filter((verb) => verb.class === TOOL_CLASS.DESTRUCTIVE)
      .map((verb) => verbAction('git', verb));

    expect(destructive.length).toBeGreaterThan(0);
    for (const action of destructive) {
      expect(
        git?.actions,
        `${action} is destructive and the baseline misses it`,
      ).toContain(action);
    }
  });

  it('leaves an ordinary push alone, because denying every push gets it uninstalled', () => {
    expect(git?.actions).not.toContain('git.push');
  });
});
