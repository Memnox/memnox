import type { DecisionEffect } from '@memnox/core';
import type { Policy } from './policy';

/** Every change is a new version pointing back, never an edit. */
export const POLICY_STATUS = {
  DRAFT: 'draft',
  PROPOSED: 'proposed',
  IN_FORCE: 'in_force',
  RETIRED: 'retired',
} as const;

export type PolicyStatus = (typeof POLICY_STATUS)[keyof typeof POLICY_STATUS];

export const PROPOSAL_ORIGIN = {
  HUMAN: 'human',
  LEAST_PRIVILEGE: 'least_privilege',
  DRIFT: 'drift',
  SYNTHESIS: 'synthesis',
} as const;

export type ProposalOrigin = (typeof PROPOSAL_ORIGIN)[keyof typeof PROPOSAL_ORIGIN];

export const PROPOSAL_STATE = {
  OPEN: 'open',
  APPROVED: 'approved',
  REJECTED: 'rejected',
  WITHDRAWN: 'withdrawn',
} as const;

export type ProposalState = (typeof PROPOSAL_STATE)[keyof typeof PROPOSAL_STATE];

/** The test file is the specification a non-engineer can read: inputs and outcomes. */
export interface PolicyTest {
  policyName: string;
  name: string;
  given: {
    action: string;
    target?: string;
    environment?: string;
    agentName?: string;
    principal?: string;
  };
  expect: { effect: DecisionEffect; require?: string[] };
}

export interface SimulationChange {
  decisionId: string;
  was: DecisionEffect;
  becomes: DecisionEffect;
  action: string;
  subjectId: string;
}

/** Both directions. What it would newly permit is the one people forget to look at. */
export interface SimulationResult {
  windowDays: number;
  evaluated: number;
  sampled: number;
  newlyWithheld: number;
  newlyAllowed: number;
  newlyEscalated: number;
  changed: SimulationChange[];
}

/** Named, not counted: an approver reads the consequence, not the syntax. */
export interface BlastRadius {
  subjects: string[];
  installs: string[];
  environments: string[];
  workflows: string[];
  owners: string[];
  estimatedMonthlyActions: number;
}

export interface Proposal {
  id: string;
  policyName?: string;
  /** The rules as they would stand, so the approver reads a diff and not a description. */
  diff: { before?: Policy; after?: Policy };
  state: ProposalState;
  origin: ProposalOrigin;
  simulation?: SimulationResult;
  blastRadius?: BlastRadius;
  proposedBy: string;
  reviewers: string[];
  decidedBy?: string;
  decidedAt?: string;
}

export const PROPOSAL_REFUSAL = {
  SELF_APPROVAL: 'a proposal needs somebody other than its author',
  UNTESTED: 'a draft failing its own test never reaches a reviewer',
  NOT_SIMULATED: 'an approver reads the consequence, so the simulation must be attached',
} as const;

export type ApprovalCheck = { ok: true } | { ok: false; reason: string };

/**
 * A rule written by one person and approved by another. Approval by the author would
 * make the review a formality, which is the whole thing being sold.
 */
export function canApprove(
  proposal: Proposal,
  approver: string,
  testsPassed: boolean,
): ApprovalCheck {
  if (!testsPassed) return { ok: false, reason: PROPOSAL_REFUSAL.UNTESTED };
  if (proposal.simulation === undefined) {
    return { ok: false, reason: PROPOSAL_REFUSAL.NOT_SIMULATED };
  }
  if (proposal.proposedBy === approver) {
    return { ok: false, reason: PROPOSAL_REFUSAL.SELF_APPROVAL };
  }
  return { ok: true };
}

/** Report both directions, so a rule that quietly widens something is visible. */
export function summarizeSimulation(
  windowDays: number,
  evaluated: number,
  changes: readonly SimulationChange[],
): SimulationResult {
  let newlyWithheld = 0;
  let newlyAllowed = 0;
  let newlyEscalated = 0;
  for (const change of changes) {
    if (change.becomes === 'withhold') newlyWithheld += 1;
    if (change.becomes === 'allow') newlyAllowed += 1;
    if (change.becomes === 'escalate') newlyEscalated += 1;
  }
  return {
    windowDays,
    evaluated,
    sampled: changes.length,
    newlyWithheld,
    newlyAllowed,
    newlyEscalated,
    changed: [...changes],
  };
}
