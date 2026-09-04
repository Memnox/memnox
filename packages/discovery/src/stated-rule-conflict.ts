import type { RepositoryEvidence, StatedRule } from './repository-evidence';

/** One action the ledger recorded, which is all this needs to see. */
export interface ActionObservation {
  agentId: string;
  action: string;
  target?: string;
  at: string;
}

/**
 * An action that ran against a sentence the repository already wrote down.
 *
 * Evidence, never a policy. This is the whole line the product rests on: a sentence in
 * AGENTS.md is material a person can act on, and it permits and forbids nothing by
 * itself. The moment text an agent can reach could refuse an action, every document in
 * the repository would become a way to write policy, and a prompt injection would be a
 * privilege escalation. So this reports, and a person writes the rule.
 */
export interface StatedRuleConflict {
  rule: StatedRule;
  agentId: string;
  action: string;
  target?: string;
  at: string;
  /** The words shared by the sentence and the action, which is why it was surfaced. */
  matchedOn: string[];
  /** Always false here, and stated so nobody reads this as an enforcement record. */
  enforced: false;
}

/** Words too common to mean anything, which would otherwise match every sentence. */
const STOPWORDS: readonly string[] = [
  'must',
  'not',
  'never',
  'always',
  'the',
  'a',
  'an',
  'and',
  'or',
  'to',
  'of',
  'in',
  'on',
  'for',
  'use',
  'used',
  'using',
  'do',
  'this',
  'that',
  'with',
  'all',
  'any',
  'be',
  'is',
  'are',
  'we',
  'our',
  'you',
  'should',
  'shall',
  'may',
  'required',
  'forbidden',
  'allowed',
];

const MIN_WORD = 4;
const MIN_OVERLAP = 2;

/**
 * Matched on shared vocabulary rather than on meaning, which is a deliberate ceiling:
 * a model reading the sentence to decide whether it was broken would be a model in the
 * path of an answer about authority, and that is the thing this codebase will not grow.
 *
 * The consequence is honest and stated: it finds a candidate a person confirms, and it
 * will miss a rule phrased in words the action does not use.
 */
export function statedRuleConflicts(
  evidence: RepositoryEvidence,
  observations: readonly ActionObservation[],
): StatedRuleConflict[] {
  const conflicts: StatedRuleConflict[] = [];
  for (const rule of evidence.stated) {
    const ruleWords = significantWords(rule.text);
    if (ruleWords.size === 0) continue;

    for (const observation of observations) {
      const subject = `${observation.action} ${observation.target ?? ''}`;
      const matchedOn = [...significantWords(subject)].filter((word) =>
        ruleWords.has(word),
      );
      if (matchedOn.length < MIN_OVERLAP) continue;
      conflicts.push({
        rule,
        agentId: observation.agentId,
        action: observation.action,
        ...(observation.target === undefined ? {} : { target: observation.target }),
        at: observation.at,
        matchedOn: matchedOn.sort(),
        enforced: false,
      });
    }
  }
  return conflicts;
}

function significantWords(text: string): Set<string> {
  const words = text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length >= MIN_WORD && !STOPWORDS.includes(word));
  return new Set(words);
}
