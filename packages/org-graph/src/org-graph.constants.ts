/**
 * What an organization can say about itself.
 *
 * Five kinds and no more: everything a company states that bears on whether an
 * action should happen is one of these. A sixth kind would be a sign the model
 * has started describing the company rather than governing it.
 */
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

/**
 * How a statement got here, which is what decides whether it may bind.
 *
 * `observed` is a machine's reading of a conversation and never binds on its
 * own. The distinction is the whole reason an extractor can run against Slack
 * without an LLM ever reaching the decision path.
 */
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

/**
 * What a statement is, as opposed to who may read it (`clearance`).
 *
 * VISION.md §31 wants both: a label survives a reader list being widened, and it
 * is what lets a retention rule or an export filter act on a statement without
 * first resolving every principal that could see it.
 */
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

/**
 * The six answers an organization can give.
 *
 * A gate has two and that is the whole reason this vocabulary exists: "no" and
 * "not by you" are different answers, and so are "ask somebody" and "ask
 * somebody in particular".
 */
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

/**
 * The workspace a single-tenant deployment operates in.
 *
 * Every organizational read is workspace-scoped, so a runtime that has no
 * tenants still needs one name to scope them to. An agent with no `orgId`
 * belongs to this one, which is what keeps a local install from having to
 * declare a tenant before it can record anything.
 */
export const DEFAULT_WORKSPACE = 'default';

/** Signals an authority verdict contributes to the audit trail. */
export const AUTHORITY_SIGNAL = {
  OVER_CEILING: 'authority:over-ceiling',
  NO_GRANT: 'authority:no-grant',
  EXPIRED: 'authority:expired',
} as const;
