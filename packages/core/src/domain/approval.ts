import { APPROVAL_STATUS, type ApprovalStatus } from '../constants/approval.constants';
import type { RiskLevel } from '../constants/risk.constants';

export interface Approval {
  id: string;
  /** Binds a grant to one exact action; any field it omits is one an agent can change. */
  requestFingerprint: string;
  agentId: string;
  action: string;
  target?: string;
  environment?: string;
  /** How much, when the action moves money. Shown to the approver, and bound. */
  amount?: number;
  /** Whose authority the agent is drawing on, when it named one. */
  principal?: string;
  /** Why it was asked for, §18 — without it an approver never learns what for. */
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
  /** When the grant was spent; absent on pre-single-use records, which stay reusable. */
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

/** Expiry is not checked: the TTL bounds a pending hold, not a grant already given. */
export function isUnspentGrant(approval: Approval, fingerprint: string): boolean {
  return (
    approval.status === APPROVAL_STATUS.APPROVED &&
    approval.requestFingerprint === fingerprint &&
    approval.consumedAt === undefined
  );
}

/** Old and finished. A pending hold is never prunable — it is a decision still owed. */
export function isApprovalPrunable(approval: Approval, cutoff: string): boolean {
  return approval.status !== APPROVAL_STATUS.PENDING && approval.createdAt < cutoff;
}
