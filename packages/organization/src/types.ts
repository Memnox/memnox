/**
 * The wire contract between an AI worker and the organization it works inside.
 *
 * This file is the protocol, and it is deliberately the whole of it. An
 * integrator should be able to read one page and know what to send: who is
 * asking, who they act for, what they intend, and what they are relying on.
 * Everything the organization does with that is on the other side of the call.
 */

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
  /**
   * Fact ids from an earlier answer that this action relies on.
   *
   * Worth sending. It is what lets the organization tell "you may not do this"
   * apart from "you may do this but should not be the one who knows it", which
   * is the difference between a refusal and a delegation.
   */
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
  /**
   * How much bearing evidence was withheld from you.
   *
   * Non-zero does not mean you were refused. It means your answer is partial
   * and you do not know how, which is a reason to involve a person rather than
   * to proceed confidently.
   */
  withheld: number;
  /** Present when there is an approval to wait on. */
  approvalId?: string;
  /** The action is allowed only with its content masked. */
  redacted?: boolean;
  /**
   * The organization holds more history than one answer reads.
   *
   * Different from `withheld`, and both are worth acting on: withheld is what
   * you were not allowed to see, this is what nobody looked at.
   */
  truncated?: true;
  /**
   * You sent no `reads`, so delegation was never assessed.
   *
   * The one thing about this call that goes wrong quietly. Without the fact ids
   * your action relies on, the organization cannot tell "you may not do this"
   * from "you may do this but should not be the one who knows it", so
   * `delegate` can never come back. If you see this and you did intend to read
   * something, send the ids.
   */
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

/**
 * A statement the organization has verified about itself.
 *
 * Typed rather than `unknown`, because the fields an integrator actually reads
 * are the ones that say whether to trust it: who confirmed it, when it took
 * effect, and what it replaced.
 */
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
  /**
   * How sure the reader was, from 0 to 1.
   *
   * Recorded even on a verified statement, because how sure we were is part of
   * the history. A declared or authoritative claim is 1: it is not a guess.
   */
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

/**
 * Another agent this company runs, offered as somewhere to send work.
 *
 * Deliberately says nothing about what that agent is cleared to know: naming
 * who should take a job must not become a way to enumerate what every other
 * agent can read. `owner` is the person accountable for it — a candidate
 * nobody answers for is not one to hand work to.
 */
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

/**
 * One earlier occasion of the same action, as the organization recorded it.
 *
 * What is deliberately absent is the answer: precedent says an action was
 * escalated to the CFO, never what the CFO was shown. A history that carried
 * content would be a way to read, over time, everything a clearance withheld.
 */
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

/**
 * Whether it is safe to go ahead without further involvement.
 *
 * Written as its own function rather than `decision === 'allow'` at a call
 * site, because the interesting case is the one people get wrong: an allow with
 * withheld context is still an allow, and an allow that came back redacted is
 * only an allow for a caller that can honour the masking.
 */
export function mayProceed(response: EvaluateResponse): boolean {
  return response.decision === DECISION.ALLOW;
}
