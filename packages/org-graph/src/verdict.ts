import type { DecisionEffect } from '@memnox/core';
import { DECISION_EFFECT } from '@memnox/core';
import { HELD_DECISIONS, ORG_DECISION, type OrgDecision } from './org-graph.constants';

/**
 * Everything the six-answer mapping is allowed to look at.
 *
 * Deliberately four booleans and an effect rather than the whole request: the
 * gate has already decided, and this turns one verdict into a more precise
 * word for it. Anything that needed more than this would be re-deciding.
 */
export interface VerdictFacts {
  /** What the deterministic gate decided. */
  effect: DecisionEffect;
  /** The organization can name who approves this. */
  hasApprovers: boolean;
  /** The action relies on facts this caller is not cleared to read. */
  reliesOnWithheldFacts: boolean;
  /** The action needs context nobody available can supply. */
  unanswerable: boolean;
}

/**
 * One gate verdict, said in the organization's vocabulary rather than the
 * gate's.
 *
 * The four answers a two-word gate cannot give, and why each one is worth its
 * own word:
 *
 * - `ask` and `escalate` differ by whether anybody is named. An agent told
 *   "somebody must approve this" and an agent told "the Finance Manager must
 *   approve this" have different next actions.
 * - `delegate` is the one this whole model exists for. "You may not do this"
 *   and "you may do this but should not be the one who knows it" are different
 *   facts about the world, and a gate that only says block conflates them into
 *   a refusal the agent will keep retrying.
 * - `clarify` is the honest answer when the organization has nothing to say and
 *   nobody to ask. Guessing here is how an agent acts confidently on a company
 *   it has misread.
 *
 * Ordering is strict and refusal wins: nothing widens a deny.
 */
export function decideFrom(facts: VerdictFacts): OrgDecision {
  if (facts.effect === DECISION_EFFECT.BLOCK) return ORG_DECISION.DENY;
  if (facts.effect === DECISION_EFFECT.REQUIRE_APPROVAL) {
    return facts.hasApprovers ? ORG_DECISION.ESCALATE : ORG_DECISION.ASK;
  }
  // Past here the gate allowed it, so what remains is whether this caller is
  // the right one to carry it out — a question about the reader, not the action.
  if (facts.reliesOnWithheldFacts) return ORG_DECISION.DELEGATE;
  if (facts.unanswerable) return ORG_DECISION.CLARIFY;
  return ORG_DECISION.ALLOW;
}

/** Whether this answer means "stop and involve somebody". */
export function isHeld(decision: OrgDecision): boolean {
  return HELD_DECISIONS.includes(decision);
}

/** A redacted allow is still an allow — masked, not refused. */
export function isRedacted(effect: DecisionEffect): boolean {
  return effect === DECISION_EFFECT.REDACT;
}
