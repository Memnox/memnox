/**
 * A decision somebody already took, found again where it applies: the rules a person or the
 * team decided, matched by the same wildcard matcher as the gate, and said in one sentence.
 */
import { DECISION_EFFECT } from '../constants/decision.constants';
import { shortDigest } from '../domain/digest';
import { matchesAny, matchesPattern } from '../policy/pattern-matcher';
import type { Policy } from '../policy/policy';
import { MOST_PROMPT_WORDS, SHORTEST_PROMPT_PATH } from './context.constants';

/** Where a decision was taken, which is what the sentence credits. */
export const DECISION_ORIGIN = {
  /** The workspace's published rules; their reason already names who decided. */
  TEAM: 'team',
  /** This machine's own rules, `memnox protect` included. */
  MACHINE: 'machine',
  /** The rules file checked into this repository. */
  REPOSITORY: 'repository',
} as const;

export type DecisionOrigin = (typeof DECISION_ORIGIN)[keyof typeof DECISION_ORIGIN];

export interface RememberedDecision {
  /** Stable for one rule from one place, so a session is shown it once. */
  id: string;
  effect: string;
  actions: readonly string[];
  targets?: readonly string[];
  statement: string;
  origin: DecisionOrigin;
  /** When a person decided it here, where this machine kept the date. */
  decidedAt?: string;
}

/** A rule a person decided on this machine, as `memnox protect` kept it for the team. */
export interface DecidedLocally {
  operation: string;
  effect: string;
  decidedAt: string;
}

/** What a decision is being matched against: one action, and what it acts on. */
export interface DecisionSubject {
  action: string;
  target?: string;
}

/** A match, with the words the sentence names it by. */
export interface DecisionFound {
  decision: RememberedDecision;
  subject: string;
}

const WILDCARD = '*';

/** The rules of one file as decisions, dated where this machine remembers deciding them. */
export function decisionsOf(
  rules: readonly Policy[],
  origin: DecisionOrigin,
  decided: readonly DecidedLocally[] = [],
): RememberedDecision[] {
  return rules.map((rule) => {
    const dated = decided.find(
      (each) =>
        each.effect === rule.decision.effect &&
        rule.match.actions.includes(each.operation),
    );
    return {
      id: shortDigest(`${origin}\u0000${rule.id ?? rule.name}`),
      effect: rule.decision.effect,
      actions: rule.match.actions,
      ...(rule.match.targets === undefined ? {} : { targets: rule.match.targets }),
      statement: rule.decision.reason ?? rule.description ?? `the rule ${rule.name}`,
      origin,
      ...(dated === undefined ? {} : { decidedAt: dated.decidedAt }),
    };
  });
}

/** The decisions covering one action. A rule for every action decides nothing about this one. */
export function decisionsCovering(
  decisions: readonly RememberedDecision[],
  subject: DecisionSubject,
): DecisionFound[] {
  return decisions
    .filter(
      (decision) =>
        !isCatchAll(decision) &&
        matchesAny(decision.actions, subject.action) &&
        matchesAny(decision.targets, subject.target),
    )
    .map((decision) => ({ decision, subject: subject.target ?? subject.action }));
}

/** The decisions a prompt names, by a path inside a rule's target or an action in words. */
export function decisionsMentioned(
  decisions: readonly RememberedDecision[],
  prompt: string,
): DecisionFound[] {
  const words = prompt.split(/\s+/).slice(0, MOST_PROMPT_WORDS).map(cleaned);
  const paths = words.filter(isPathLike);
  const text = ` ${words.join(' ').toLowerCase()} `;
  return decisions.flatMap((decision) => {
    const path = paths.find((each) => targetNames(decision, each));
    if (path !== undefined) return [{ decision, subject: path }];
    const spoken = decision.targets === undefined ? actionSpoken(decision, text) : null;
    return spoken === null ? [] : [{ decision, subject: spoken }];
  });
}

/** One sentence: what it covers, what was decided, and where it was decided. */
export function describeDecision(found: DecisionFound): string {
  const { decision } = found;
  const dated =
    decision.decidedAt === undefined ? '' : ` on ${decision.decidedAt.slice(0, 10)}`;
  const origin = ORIGIN_WORDS[decision.origin];
  return `A previous decision covers ${found.subject}: ${EFFECT_WORDS[decision.effect] ?? decision.effect}, because ${decision.statement} (${origin}${dated}).`;
}

const EFFECT_WORDS: Readonly<Record<string, string>> = {
  [DECISION_EFFECT.DENY]: 'it is never run',
  [DECISION_EFFECT.ASK]: 'a person is asked first',
  [DECISION_EFFECT.ALLOW]: 'it goes ahead',
};

const ORIGIN_WORDS: Readonly<Record<DecisionOrigin, string>> = {
  [DECISION_ORIGIN.TEAM]: "your team's published rules",
  [DECISION_ORIGIN.MACHINE]: 'decided on this machine',
  [DECISION_ORIGIN.REPOSITORY]: "this repository's rules",
};

function isCatchAll(decision: RememberedDecision): boolean {
  return decision.targets === undefined && decision.actions.includes(WILDCARD);
}

/** Quotes, brackets and a closing full stop taken off, which prose wraps a path in. */
function cleaned(word: string): string {
  return word.replace(/^[`'"([{<]+/, '').replace(/[`'")\]}>,;:!?]+$|\.$/g, '');
}

function isPathLike(word: string): boolean {
  return (
    word.length >= SHORTEST_PROMPT_PATH && (word.includes('/') || /\.\w+$/.test(word))
  );
}

/** `payments/` names a rule on `src/payments` and below, and `.env` one on every `.env`. */
function targetNames(decision: RememberedDecision, path: string): boolean {
  const bare = path.replace(/^\.\//, '').replace(/\/+$/, '').toLowerCase();
  return (decision.targets ?? []).some(
    (pattern) =>
      matchesPattern(pattern, path) ||
      pattern.replaceAll(WILDCARD, '').toLowerCase().includes(bare),
  );
}

/** `git.push` spoken as "git push", for an action rule with no target to name it by. */
function actionSpoken(decision: RememberedDecision, text: string): string | null {
  const spoken = decision.actions
    .filter((action) => !action.includes(WILDCARD) && action.includes('.'))
    .map((action) => action.replaceAll('.', ' ').toLowerCase())
    .find((phrase) => text.includes(` ${phrase} `));
  return spoken ?? null;
}
