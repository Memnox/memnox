import { APPROVAL_STATUS } from '../constants/approval.constants';
import { isApprovalExpired, type Approval } from './approval';

/** Approvers listed in the summary, most active first. */
const TOP_APPROVERS = 10;

const MS_PER_MINUTE = 60_000;
const P90 = 0.9;

/**
 * Where approvals stall, derived from the records alone. Every duration is in
 * minutes because the numbers a human acts on are "hours" and "days", not
 * milliseconds.
 */
export interface ApprovalFlowSummary {
  total: number;
  pending: number;
  approved: number;
  denied: number;
  /** Pending past its TTL: never resolved by anyone, and no longer consent. */
  lapsed: number;
  /** Approved by admin break-glass rather than the named approvers. */
  overrides: number;
  /** Null when nothing has been resolved yet — not zero, which reads as "instant". */
  medianResolveMinutes: number | null;
  p90ResolveMinutes: number | null;
  /** How long the oldest unresolved approval has been waiting. */
  oldestPendingMinutes: number | null;
  approverActivity: Array<{ approver: string; grants: number }>;
}

/**
 * Pure. `now` is passed in rather than read so a summary over the same records
 * is reproducible — the same discipline as evaluateConsent and isApprovalExpired.
 */
export function summarizeApprovalFlow(
  approvals: Approval[],
  now: Date = new Date(),
): ApprovalFlowSummary {
  const resolveMinutes: number[] = [];
  const grants = new Map<string, number>();
  let pending = 0;
  let approved = 0;
  let denied = 0;
  let lapsed = 0;
  let overrides = 0;
  let oldestPendingMinutes: number | null = null;

  for (const approval of approvals) {
    if (approval.status === APPROVAL_STATUS.APPROVED) approved += 1;
    if (approval.status === APPROVAL_STATUS.DENIED) denied += 1;
    if (approval.override === true) overrides += 1;

    for (const grant of approval.grants) {
      grants.set(grant.by, (grants.get(grant.by) ?? 0) + 1);
    }

    if (approval.resolvedAt !== undefined) {
      resolveMinutes.push(elapsedMinutes(approval.createdAt, approval.resolvedAt));
      continue;
    }

    // Unresolved: either still waiting for a human, or waited too long and lapsed.
    // A record already marked expired lapsed too — it just got swept first.
    if (approval.status === APPROVAL_STATUS.EXPIRED) {
      lapsed += 1;
      continue;
    }
    if (approval.status !== APPROVAL_STATUS.PENDING) continue;
    if (isApprovalExpired(approval, now)) {
      lapsed += 1;
      continue;
    }
    pending += 1;
    const waiting = elapsedMinutes(approval.createdAt, now.toISOString());
    if (oldestPendingMinutes === null || waiting > oldestPendingMinutes) {
      oldestPendingMinutes = waiting;
    }
  }

  return {
    total: approvals.length,
    pending,
    approved,
    denied,
    lapsed,
    overrides,
    medianResolveMinutes: percentile(resolveMinutes, 0.5),
    p90ResolveMinutes: percentile(resolveMinutes, P90),
    oldestPendingMinutes,
    approverActivity: [...grants.entries()]
      .sort(([, a], [, b]) => b - a)
      .slice(0, TOP_APPROVERS)
      .map(([approver, count]) => ({ approver, grants: count })),
  };
}

function elapsedMinutes(from: string, to: string): number {
  return Math.max(0, (Date.parse(to) - Date.parse(from)) / MS_PER_MINUTE);
}

/** Nearest-rank on a copy; an empty set has no percentile, so null rather than 0. */
function percentile(values: number[], fraction: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil(fraction * sorted.length);
  const index = Math.min(sorted.length - 1, Math.max(0, rank - 1));
  const value = sorted[index];
  if (value === undefined) return null;
  return Math.round(value);
}
