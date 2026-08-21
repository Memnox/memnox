/** Five kinds and no more; everything bearing on an action is one of them. */
export const STATED_KIND = {
  /** A course the company committed to. */
  DECISION: 'decision',
  /** A rule the company holds itself to. */
  POLICY: 'policy',
  /** Somebody may authorize something, optionally up to a limit. */
  AUTHORITY: 'authority',
  /** Somebody owns something and answers for it. */
  RESPONSIBILITY: 'responsibility',
  /** How two parties stand to each other — reports to, belongs to. */
  RELATIONSHIP: 'relationship',
} as const;

export type StatedKind = (typeof STATED_KIND)[keyof typeof STATED_KIND];

/** How it got here decides whether it may bind; `observed` never binds alone. */
export const STATED_PROVENANCE = {
  /** Read out of a source by a machine. Always starts as a candidate. */
  OBSERVED: 'observed',
  /** A person entered it. */
  DECLARED: 'declared',
  /** It came from a system of record. */
  AUTHORITATIVE: 'authoritative',
} as const;

export type StatedProvenance = (typeof STATED_PROVENANCE)[keyof typeof STATED_PROVENANCE];

export const STATED_STATUS = {
  /** Proposed and not yet confirmed. Never binds. */
  CANDIDATE: 'candidate',
  /** A person confirmed it. Binds. */
  VERIFIED: 'verified',
  /** A newer statement replaced it. */
  SUPERSEDED: 'superseded',
  /** A person confirmed it is wrong. */
  REJECTED: 'rejected',
} as const;

export type StatedStatus = (typeof STATED_STATUS)[keyof typeof STATED_STATUS];

/** What a statement is, not who may read it — §31 wants both, and a label survives. */
export const STATED_CLASSIFICATION = {
  PUBLIC: 'public',
  INTERNAL: 'internal',
  CONFIDENTIAL: 'confidential',
  RESTRICTED: 'restricted',
} as const;

export type StatedClassification =
  (typeof STATED_CLASSIFICATION)[keyof typeof STATED_CLASSIFICATION];

/** Unlabelled is internal, never public: an omitted label must not widen reach. */
export const DEFAULT_CLASSIFICATION: StatedClassification =
  STATED_CLASSIFICATION.INTERNAL;

/** A declared or authoritative claim is not a guess, so it is recorded as certain. */
export const CERTAIN_CONFIDENCE = 1;

/** A gate has two answers: "no" and "not by you" differ, which is why there are six. */
export const ORG_DECISION = {
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

export type OrgDecision = (typeof ORG_DECISION)[keyof typeof ORG_DECISION];

/** The five answers that mean "do not go ahead on your own". */
export const HELD_DECISIONS: readonly OrgDecision[] = [
  ORG_DECISION.DENY,
  ORG_DECISION.ASK,
  ORG_DECISION.ESCALATE,
  ORG_DECISION.DELEGATE,
  ORG_DECISION.CLARIFY,
];

/** Every organizational read is workspace-scoped, so a single tenant still needs one. */
export const DEFAULT_WORKSPACE = 'default';

/** Signals an authority verdict contributes to the audit trail. */
export const AUTHORITY_SIGNAL = {
  OVER_CEILING: 'authority:over-ceiling',
  NO_GRANT: 'authority:no-grant',
  EXPIRED: 'authority:expired',
} as const;
