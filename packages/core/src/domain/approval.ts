import { APPROVAL_STATUS, type ApprovalStatus } from '../constants/approval.constants';

export interface Approval {
  id: string;
  /** Binds the approval to one exact action — agent, action, target, environment. */
  requestFingerprint: string;
  agentId: string;
  action: string;
  target?: string;
  environment?: string;
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
 * Retention: old and finished. A pending hold is never prunable no matter how
 * old — it is a decision a human still owes, and deleting it would erase the ask.
 */
export function isApprovalPrunable(approval: Approval, cutoff: string): boolean {
  return approval.status !== APPROVAL_STATUS.PENDING && approval.createdAt < cutoff;
}
