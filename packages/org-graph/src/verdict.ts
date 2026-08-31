import type { DecisionEffect } from '@memnox/core';
import { DECISION_EFFECT } from '@memnox/core';
import { HELD_DECISIONS, ORG_DECISION, type OrgDecision } from './org-graph.constants';

/** Four booleans and an effect, not the request: anything more would be re-deciding. */
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

/** One gate verdict in the organization's vocabulary; refusal wins, nothing widens a deny. */
export function decideFrom(facts: VerdictFacts): OrgDecision {
  if (facts.effect === DECISION_EFFECT.WITHHOLD) return ORG_DECISION.DENY;
  if (facts.effect === DECISION_EFFECT.ESCALATE) {
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
