/** The wire contract between an AI worker and its organization — deliberately all of it. */

/** What should happen next. Six answers, because a gate's two are not enough. */
export const DECISION = {
  /** Proceed. */
  ALLOW: 'allow',
  /** A rule forbids it. Final: nothing widens a refusal. */
  DENY: 'deny',
  /** Approval is required and nobody is named. */
  ASK: 'ask',
  /** Approval is required and the organization names who gives it. */
  ESCALATE: 'escalate',
  /** You may act but may not know. Somebody who can, owns this. */
  DELEGATE: 'delegate',
  /** Context is missing and nobody available can supply it. Ask a person. */
  CLARIFY: 'clarify',
} as const;

export type Decision = (typeof DECISION)[keyof typeof DECISION];

/** The four decisions that mean "do not go ahead on your own". */
const HELD: readonly Decision[] = [
  DECISION.DENY,
  DECISION.ASK,
  DECISION.ESCALATE,
  DECISION.DELEGATE,
  DECISION.CLARIFY,
];

export interface EvaluateRequest {
  /** Namespaced verb, e.g. `payment.refund`, `email.send`, `deploy.service`. */
  action: string;
  /** What it operates on. */
  resource?: { type?: string; id?: string };
  /** The person this call is made on behalf of. Decides who may act alone. */
  principal?: string;
  /** Size, in whatever unit the action counts in. What an authority limits. */
  amount?: number;
  environment?: string;
  /** Your intent, in your own words. Recorded verbatim in the ledger. */
  reason?: string;
  /** Tells "you may not do this" from "you may, but should not be the one who knows". */
  reads?: readonly string[];
}

/** Somebody who can authorize the action, and why they can. */
export interface Approver {
  id: string;
  /** The statement that grants them the authority, in the company's words. */
  because: string;
  limit?: number;
}

/** One fact the organization is willing to tell this caller. */
export interface Fact {
  id: string;
  sourceType: string;
  sourceRef?: string;
  author?: string;
  occurredAt: string;
  content: string;
  /** Untrusted provenance. Never strip this before showing it to a model. */
  tainted: boolean;
}

export interface EvaluateResponse {
  decision: Decision;
  reason: string;
  approvers: Approver[];
  /** Organizational statements that bore on this, by id. */
  policies: string[];
  /** What you may know that bears on the action. */
  context: Fact[];
  /** Limits to respect in whatever you do next. Carry them into your prompt. */
  constraints: string[];
  /** Facts the action needs that you are not cleared to read. */
  missingContext: string[];
  /** Non-zero is not a refusal: your answer is partial and you do not know how. */
  withheld: number;
  /** Present when there is an approval to wait on. */
  approvalId?: string;
  /** Withheld is what you could not see; this is what one answer did not read. */
  truncated?: true;
  /** The one thing that goes wrong quietly: no `reads`, so delegation went unassessed. */
  delegationNotAssessed?: true;
}

export interface ContextResponse {
  question: string;
  facts: Fact[];
  decisions: Decided[];
  withheld: number;
  restrictions: string[];
  principal?: string;
  /** The organization holds more history than one answer reads. */
  truncated?: true;
}

/** A decision the organization has approved and holds itself to. */
export interface Decided {
  id: string;
  title: string;
  statement: string;
  owner?: string;
  targets?: string[];
  status?: string;
  sourceRef?: string;
}

/** Typed, because an integrator reads exactly the fields that say whether it binds. */
export interface Stated {
  id: string;
  workspaceId: string;
  kind: 'decision' | 'policy' | 'authority' | 'responsibility' | 'relationship';
  statement: string;
  subject: string;
  principal?: string;
  capability?: string;
  limit?: number;
  object?: string;
  provenance: 'observed' | 'declared' | 'authoritative';
  status: 'candidate' | 'verified' | 'superseded' | 'rejected';
  version: number;
  sourceRef?: string;
  /** Event ids this was read out of, so "why" is a lookup rather than a guess. */
  evidence: string[];
  /** Recorded even when verified: how sure we were is part of the history. */
  confidence: number;
  detectedAt: string;
  verifiedAt?: string;
  verifiedBy?: string;
  effectiveFrom?: string;
  effectiveTo?: string;
}

/** Who owns something, and the decision that makes them its owner. */
export interface Ownership {
  subject: string;
  owners: Array<{ name: string; throughDecision: string }>;
}

/** Says nothing about what that agent may know — naming a recipient is not clearing it. */
export interface AgentCandidate {
  agentId: string;
  label: string;
  /** The actions it states it is for, as namespaced verbs. */
  capabilities: string[];
  owner?: string;
  principal?: string;
  department?: string;
  /** The largest amount it may act on alone, when it has a ceiling. */
  spendLimit?: number;
}

/** The answer is deliberately absent: precedent says it was escalated, not how it ended. */
export interface Precedent {
  occurredAt: string;
  /** allow, deny, ask, escalate, delegate or clarify, as it was then. */
  verb: string;
  target?: string;
  /** What that asker said they were doing, in their own words. */
  intent?: string;
  /** Why it was routed that way. */
  reason?: string;
  /** Who it went to. Empty for allow, deny and clarify. */
  to: string[];
}

export interface ShareResponse {
  shareable: boolean;
  /** Why not, in words that name the rule and never repeat the content. */
  refusal?: string;
  unknownFact?: true;
  unknownRecipient?: true;
}

/** Whether this answer means "stop and involve somebody". */
export function isHeld(decision: Decision): boolean {
  return HELD.includes(decision);
}

/** Its own function rather than a bare equality check, because the other answers differ. */
export function mayProceed(response: EvaluateResponse): boolean {
  return response.decision === DECISION.ALLOW;
}
