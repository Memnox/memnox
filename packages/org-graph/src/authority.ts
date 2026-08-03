import type { DecisionEffect } from '@memnox/core';
import { DECISION_EFFECT } from '@memnox/core';
import { matchesAny } from '@memnox/policy-engine';
import { AUTHORITY_SIGNAL } from './org-graph.constants';

/** What exceeding a delegation costs. Never allow — a ceiling that allows is not one. */
export type OverLimitEffect = Extract<DecisionEffect, 'require_approval' | 'block'>;

/**
 * What one person has delegated to the agents acting for them.
 *
 * The distinction this exists to draw: a person's own authority and the
 * authority their agent carries are not the same number. Alice may approve
 * fifty thousand and Alice's assistant five, and without somewhere to say so
 * the only expressible answer is that the agent inherits everything Alice can
 * do — which is the failure the whole delegation model is for.
 */
export interface AuthorityGrant {
  id: string;
  workspaceId: string;
  /** The person whose authority this draws on. */
  principal: string;
  /** Agent name patterns this covers; unset = every agent acting for the principal. */
  agents?: string[];
  /** Action patterns the grant covers, e.g. `payment.refund`, `email.*`. */
  actions: string[];
  /**
   * The largest amount an agent may act on alone under this grant, in the unit
   * the action counts in. Unset means the grant carries no ceiling — it says
   * what the agent may attempt, not how big.
   */
  limit?: number;
  /** What happens past the ceiling. Defaults to asking a person. */
  overLimit?: OverLimitEffect;
  /** Who signs it off past the ceiling. */
  approvers?: string[];
  /**
   * When the grant stops applying. Temporary authority — "this agent may read
   * the financial report for the next two hours" — is this field and nothing
   * else.
   */
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

/**
 * Whether an agent is acting inside what its principal delegated.
 *
 * Escalation-only and total: every path returns either one escalation or
 * nothing, so this can never widen a verdict the policy engine reached.
 *
 * Three rules, in the order they fire:
 *
 * 1. A request that names no principal is not delegated work, and there is
 *    nothing to check. The gate's own rules still apply.
 * 2. A principal the organization has recorded nothing about is unconfigured,
 *    not unauthorized. Escalating here would mean that switching the feature on
 *    stops every agent in the company until somebody writes a grant for each
 *    person, and a control that has to be disabled on its first day is one
 *    nobody keeps.
 * 3. Once a principal has any grant at all, their remit is declared, and
 *    anything outside it is a question for a person. This is what makes "the
 *    assistant may draft emails and schedule meetings, and may not sign
 *    contracts" enforceable rather than advisory.
 */
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

/**
 * Whether the action fits under the grant's ceiling.
 *
 * An action that does not say how big it is does **not** fit. It cannot prove
 * it is under the line, and letting an unstated size past the ceiling written
 * for size is exactly how a delegation gets bypassed — by omission, silently,
 * by a caller that never had to lie. Same rule the policy engine applies to
 * `aboveAmount`, and it has to stay the same rule.
 */
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
