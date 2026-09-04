import { createHash } from 'node:crypto';
import {
  STATE_FACT_KIND,
  STATE_VERSION_ALGORITHM,
  STATE_VERSION_LENGTH,
  STATE_VERSION_NONE,
  type StateFactKind,
} from '../constants/state-fact.constants';

/**
 * What is true right now, with a scope and an expiry: a freeze, an open incident, a
 * change window, a customer hold. The condition an agent has no way at all to acquire
 * on its own, compiled into what a local evaluator already holds.
 *
 * The fact is supplied. Where it came from — a channel, an incident tool — is the
 * cloud's half; honouring one is this half's.
 */
export interface StateFact {
  id: string;
  kind: StateFactKind;
  /** What it covers, in the words a rule matches on: "production", "payments". */
  scope: string[];
  /** Why, verbatim from whoever declared it. Never a paraphrase. */
  reason: string;
  /** Who said so, so the fact can be argued with rather than merely obeyed. */
  source: string;
  declaredAt: string;
  /**
   * Mandatory. A freeze that outlives its incident is worse than no freeze, because
   * the next one gets ignored — and the one after that is the real emergency.
   */
  validUntil: string;
}

export const STATE_FACT_REFUSAL = {
  NO_EXPIRY: 'a state fact without validUntil would outlive whatever caused it',
  EXPIRES_BEFORE_IT_STARTS: 'validUntil is at or before declaredAt',
  NO_SCOPE: 'a state fact covering nothing cannot be matched against anything',
  NO_SOURCE: 'a fact nobody is named for is one nobody can argue with',
} as const;

export type StateFactRefusal =
  (typeof STATE_FACT_REFUSAL)[keyof typeof STATE_FACT_REFUSAL];

/**
 * Refuses a fact that carries no expiry, and says why. Pure: it reads the record and
 * never a clock, so the same fact validates the same way on every machine.
 */
export function validateStateFact(fact: StateFact): StateFactRefusal[] {
  const refusals: StateFactRefusal[] = [];
  if (typeof fact.validUntil !== 'string' || fact.validUntil === '') {
    refusals.push(STATE_FACT_REFUSAL.NO_EXPIRY);
  } else if (fact.validUntil <= fact.declaredAt) {
    refusals.push(STATE_FACT_REFUSAL.EXPIRES_BEFORE_IT_STARTS);
  }
  if (fact.scope.length === 0) refusals.push(STATE_FACT_REFUSAL.NO_SCOPE);
  if (fact.source === '') refusals.push(STATE_FACT_REFUSAL.NO_SOURCE);
  return refusals;
}

/**
 * Which facts still stand at a given moment. The moment is an argument, never a clock
 * read inside the evaluator, so a verdict is reproducible and a replay a year later
 * reaches the same answer.
 */
export function stateFactsInForce(facts: readonly StateFact[], at: string): StateFact[] {
  return facts.filter(
    (fact) => validateStateFact(fact).length === 0 && at < fact.validUntil,
  );
}

/** Whether any fact in force covers this environment or target. */
export function stateFactCovering(
  facts: readonly StateFact[],
  subject: string,
  at: string,
): StateFact | null {
  const lowered = subject.toLowerCase();
  return (
    stateFactsInForce(facts, at).find((fact) =>
      fact.scope.some((each) => each.toLowerCase() === lowered),
    ) ?? null
  );
}

/** One line a person reads: what is in force, why, and until when. */
export function describeStateFact(fact: StateFact): string {
  const kind = fact.kind === STATE_FACT_KIND.FREEZE ? 'freeze' : fact.kind;
  return `${kind} on ${fact.scope.join(', ')} until ${fact.validUntil} — ${fact.reason} (${fact.source})`;
}

/**
 * The labels a rule's `match.state` is compared against. One per kind and one per
 * kind:scope pair, so a rule can say "any freeze" or "a freeze on payments" without
 * the evaluator needing to understand either word.
 */
export function stateLabelsOf(facts: readonly StateFact[], at: string): string[] {
  const labels = new Set<string>();
  for (const fact of stateFactsInForce(facts, at)) {
    labels.add(fact.kind);
    for (const scope of fact.scope) labels.add(`${fact.kind}:${scope.toLowerCase()}`);
  }
  return [...labels].sort();
}

/**
 * Content version of the facts in force, stamped onto every verdict decided against
 * them. A freeze that never reached a machine is a version that never changed there,
 * which is how a bundle that failed to propagate becomes visible instead of silent.
 */
export function stateVersionOf(facts: readonly StateFact[], at: string): string {
  const inForce = stateFactsInForce(facts, at);
  if (inForce.length === 0) return STATE_VERSION_NONE;
  const ids = inForce.map((fact) => `${fact.id}@${fact.validUntil}`).sort();
  return createHash(STATE_VERSION_ALGORITHM)
    .update(ids.join('\n'))
    .digest('hex')
    .slice(0, STATE_VERSION_LENGTH);
}
