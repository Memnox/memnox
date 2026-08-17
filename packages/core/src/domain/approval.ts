import { APPROVAL_STATUS, type ApprovalStatus } from '../constants/approval.constants';
import type { RiskLevel } from '../constants/risk.constants';

export interface Approval {
  id: string;
  /**
   * Binds the approval to one exact action — agent, action, target,
   * environment, amount, principal. Every field a grant does *not* cover is a
   * field an agent can change and still spend the same grant.
   */
  requestFingerprint: string;
  agentId: string;
  action: string;
  target?: string;
  environment?: string;
  /** How much, when the action moves money. Shown to the approver, and bound. */
  amount?: number;
  /** Whose authority the agent is drawing on, when it named one. */
  principal?: string;
  /**
   * Why it was asked for, §18. Without it an approver is told what an agent
   * wants and never what for, which is the whole question they are being asked.
   */
  reason?: string;
  /** Which rule forced the ask, §18. Names the policy, not the effect. */
  policyTriggered?: string;
  /** How bad it would be if this were wrong, §16. Drives how it is presented. */
  risk?: RiskLevel;
  /** What the agent had been told when it decided to ask, §18. Free-form, for the record. */
  context?: string;
  approvers: string[];
  /** Distinct people required; 1 unless a policy asked for more. */
  minApprovals: number;
  /** Who has approved so far, in order. One person counts once. */
  grants: ApprovalGrant[];
  status: ApprovalStatus;
  createdAt: string;
  /** Pending approvals lapse at this time; missing on pre-TTL records = never. */
  expiresAt?: string;
  resolvedAt?: string;
  resolvedBy?: string;
  /**
   * When this grant was spent. A grant authorizes one action: a human approving
   * "write this file" agreed to that write, not to every write of it until the
   * TTL runs out. Absent on records written before single-use grants shipped,
   * which therefore stay reusable rather than retroactively failing closed.
   */
  consumedAt?: string;
  /** Set when an admin break-glass override approved this without the named approvers. */
  override?: boolean;
  /** Owning org/workspace; unset = single-tenant deployment. */
  orgId?: string;
}

export interface ApprovalGrant {
  by: string;
  at: string;
}

/** One denial ends it; approvals accumulate until the quorum is met. */
export function applyGrant(
  approval: Approval,
  by: string,
  at: string,
): { approval: Approval; satisfied: boolean } {
  const alreadyGranted = approval.grants.some((grant) => grant.by === by);
  const grants = alreadyGranted ? approval.grants : [...approval.grants, { by, at }];
  return {
    approval: { ...approval, grants },
    satisfied: grants.length >= approval.minApprovals,
  };
}

export function isApprovalExpired(approval: Approval, now: Date = new Date()): boolean {
  return Boolean(approval.expiresAt && approval.expiresAt <= now.toISOString());
}

/**
 * A grant that still authorizes this exact action: approved, for this
 * fingerprint, and not already spent. Expiry is deliberately not checked — the
 * TTL bounds how long a *pending* hold waits for a human, and a grant a human
 * actually gave should not evaporate while the agent is retrying.
 */
export function isUnspentGrant(approval: Approval, fingerprint: string): boolean {
  return (
    approval.status === APPROVAL_STATUS.APPROVED &&
    approval.requestFingerprint === fingerprint &&
    approval.consumedAt === undefined
  );
}

/**
 * Retention: old and finished. A pending hold is never prunable no matter how
 * old — it is a decision a human still owes, and deleting it would erase the ask.
 */
export function isApprovalPrunable(approval: Approval, cutoff: string): boolean {
  return approval.status !== APPROVAL_STATUS.PENDING && approval.createdAt < cutoff;
}
