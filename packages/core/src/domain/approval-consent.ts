import { APPROVAL_STATUS } from '../constants/approval.constants';
import { isApprovalExpired, type Approval } from './approval';

/** What a stored approval means for the request now presenting it. */
export const CONSENT = {
  GRANTED: 'granted',
  DENIED: 'denied',
  /** Pending but lapsed — the caller must retire it and re-evaluate. */
  EXPIRED: 'expired',
  /** No approval, wrong action, or still awaiting approvers. */
  NOT_APPLICABLE: 'not_applicable',
} as const;

export type Consent = (typeof CONSENT)[keyof typeof CONSENT];

/**
 * Pure: an approval only speaks for the exact action it was raised against, so
 * the fingerprint must match before its status means anything at all.
 */
export function evaluateConsent(
  approval: Approval | null,
  expectedFingerprint: string,
  now: Date = new Date(),
): Consent {
  if (!approval || approval.requestFingerprint !== expectedFingerprint) {
    return CONSENT.NOT_APPLICABLE;
  }
  if (approval.status === APPROVAL_STATUS.PENDING) {
    return isApprovalExpired(approval, now) ? CONSENT.EXPIRED : CONSENT.NOT_APPLICABLE;
  }
  // A spent grant is not consent: it already authorized the action it was for.
  if (approval.consumedAt !== undefined) return CONSENT.NOT_APPLICABLE;
  if (approval.status === APPROVAL_STATUS.APPROVED) return CONSENT.GRANTED;
  if (approval.status === APPROVAL_STATUS.DENIED) return CONSENT.DENIED;
  return CONSENT.NOT_APPLICABLE;
}
