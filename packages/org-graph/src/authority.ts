import type { DecisionEffect } from '@memnox/core';
import { DECISION_EFFECT } from '@memnox/core';
import { matchesAny } from '@memnox/policy-engine';
import { AUTHORITY_SIGNAL } from './org-graph.constants';

/** What exceeding a delegation costs. Never allow — a ceiling that allows is not one. */
export type OverLimitEffect = Extract<DecisionEffect, 'require_approval' | 'block'>;

/** A person's own authority and what their agent carries are different numbers. */
export interface AuthorityGrant {
  id: string;
  workspaceId: string;
  /** The person whose authority this draws on. */
  principal: string;
  /** Agent name patterns this covers; unset = every agent acting for the principal. */
  agents?: string[];
  /** Action patterns the grant covers, e.g. `payment.refund`, `email.*`. */
  actions: string[];
  /** Unset means no ceiling — the grant says what the agent may do, not how much. */
  limit?: number;
  /** What happens past the ceiling. Defaults to asking a person. */
  overLimit?: OverLimitEffect;
  /** Who signs it off past the ceiling. */
  approvers?: string[];
  /** Temporary authority is this field and nothing else. */
  expiresAt?: string;
  grantedBy: string;
  grantedAt: string;
}

export interface AuthorityStore {
  save(grant: AuthorityGrant): Promise<void>;
  /** Every grant in a workspace. Selection is the caller's, so it stays pure. */
  list(workspaceId: string): Promise<AuthorityGrant[]>;
  remove(id: string): Promise<boolean>;
}

/** Nothing to say, or one escalation with the reason a person will read. */
export interface AuthorityVerdict {
  escalateTo: OverLimitEffect;
  reason: string;
  approvers: string[];
  signal: string;
}

export interface AuthorityQuestion {
  principal: string | undefined;
  agentName: string;
  action: string;
  amount: number | undefined;
}

/** Escalation-only and total: every path returns one escalation or nothing. */
export function evaluateAuthority(
  grants: readonly AuthorityGrant[],
  question: AuthorityQuestion,
  now: Date,
): AuthorityVerdict | null {
  const principal = question.principal;
  if (principal === undefined) return null;

  const mine = grants.filter((grant) => grant.principal === principal);
  if (mine.length === 0) return null;

  const applicable = mine.filter(
    (grant) =>
      matchesAny(grant.agents, question.agentName) &&
      matchesAny(grant.actions, question.action),
  );
  if (applicable.length === 0) {
    return {
      escalateTo: DECISION_EFFECT.REQUIRE_APPROVAL,
      reason: `${principal} has delegated nothing covering "${question.action}"`,
      approvers: approversOf(mine),
      signal: AUTHORITY_SIGNAL.NO_GRANT,
    };
  }

  const live = applicable.filter((grant) => !hasExpired(grant, now));
  if (live.length === 0) {
    return {
      escalateTo: DECISION_EFFECT.REQUIRE_APPROVAL,
      reason: `${principal}'s delegation for "${question.action}" has expired`,
      approvers: approversOf(applicable),
      signal: AUTHORITY_SIGNAL.EXPIRED,
    };
  }

  const within = live.filter((grant) => isWithinCeiling(grant, question.amount));
  if (within.length > 0) return null;

  // The tightest grant names the consequence: when one delegation would block
  // and another only asks, the agent has been told no by the stricter of them.
  const strictest = live.reduce((tightest, grant) =>
    overLimitOf(grant) === DECISION_EFFECT.BLOCK ? grant : tightest,
  );
  return {
    escalateTo: overLimitOf(strictest),
    reason: describeCeiling(principal, question, live),
    approvers: approversOf(live),
    signal: AUTHORITY_SIGNAL.OVER_CEILING,
  };
}

/** An action that does not state its size does not fit: it cannot prove it is under. */
function isWithinCeiling(grant: AuthorityGrant, amount: number | undefined): boolean {
  if (grant.limit === undefined) return true;
  if (amount === undefined) return false;
  return amount <= grant.limit;
}

function hasExpired(grant: AuthorityGrant, now: Date): boolean {
  if (grant.expiresAt === undefined) return false;
  return now.getTime() >= Date.parse(grant.expiresAt);
}

function overLimitOf(grant: AuthorityGrant): OverLimitEffect {
  return grant.overLimit ?? DECISION_EFFECT.REQUIRE_APPROVAL;
}

/** The highest ceiling any live grant carries — grants add up, they do not cancel. */
function highestCeiling(grants: readonly AuthorityGrant[]): number | undefined {
  const limits = grants
    .map((grant) => grant.limit)
    .filter((limit): limit is number => limit !== undefined);
  return limits.length === 0 ? undefined : Math.max(...limits);
}

function describeCeiling(
  principal: string,
  question: AuthorityQuestion,
  grants: readonly AuthorityGrant[],
): string {
  const ceiling = highestCeiling(grants);
  const stated = ceiling === undefined ? 'a ceiling' : String(ceiling);
  if (question.amount === undefined) {
    return `${principal} delegated "${question.action}" up to ${stated} and this action does not say how big it is`;
  }
  return `${question.amount} is above the ${stated} ${principal} delegated for "${question.action}"`;
}

function approversOf(grants: readonly AuthorityGrant[]): string[] {
  const named = new Set<string>();
  for (const grant of grants) {
    for (const approver of grant.approvers ?? []) named.add(approver);
    // The person who delegated is always somebody who can answer for the excess.
    named.add(grant.principal);
  }
  return [...named];
}
