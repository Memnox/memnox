export const APPROVAL_STATUS = {
  PENDING: 'pending',
  APPROVED: 'approved',
  DENIED: 'denied',
  EXPIRED: 'expired',
} as const;

export type ApprovalStatus = (typeof APPROVAL_STATUS)[keyof typeof APPROVAL_STATUS];

/** Pending approvals lapse after this long — a stale approval is not consent. */
export const APPROVAL_TTL_MS = 7 * 24 * 60 * 60 * 1_000;

/** One approver unless a policy demands a larger quorum. */
export const DEFAULT_MIN_APPROVALS = 1;
