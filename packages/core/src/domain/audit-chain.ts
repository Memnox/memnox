import { createHash } from 'node:crypto';
import type { ActionEvent } from './action-event';
import { canonicalJson } from './canonical-json';

/** prevHash of the very first event ever appended. */
export const GENESIS_HASH = '0'.repeat(64);

export const AUDIT_CHAIN_BREAK = {
  MISSING_HASH: 'missing-hash',
  PREV_MISMATCH: 'prev-hash-mismatch',
  CONTENT_MISMATCH: 'content-mismatch',
} as const;

export type AuditChainBreak = (typeof AUDIT_CHAIN_BREAK)[keyof typeof AUDIT_CHAIN_BREAK];

export interface AuditChainVerification {
  valid: boolean;
  /** Events inspected before the verdict. */
  checked: number;
  /** Chronological position of the first broken link; -1 when the chain is intact. */
  brokenAtIndex: number;
  brokenEventId?: string;
  brokenReason?: AuditChainBreak;
}

const HASH_ALGORITHM = 'sha256';
const HASH_ENCODING = 'hex';

function computeEventHash(event: ActionEvent, prevHash: string): string {
  const { hash: _hash, prevHash: _prevHash, ...content } = event;
  return createHash(HASH_ALGORITHM)
    .update(`${canonicalJson(content)}${prevHash}`)
    .digest(HASH_ENCODING);
}

/** Links an event to the one before it — audit logs call this at append time. */
export function chainAuditEvent(event: ActionEvent, prevHash: string): ActionEvent {
  const linked: ActionEvent = { ...event, prevHash };
  return { ...linked, hash: computeEventHash(linked, prevHash) };
}

/** Verifies in pages, anchored on the first prevHash so a pruned prefix still passes. */
export class AuditChainVerifier {
  private expectedPrev: string | null = null;
  private index = 0;
  private broken: AuditChainVerification | null = null;

  /** False once the chain is broken — callers can stop reading pages. */
  push(event: ActionEvent): boolean {
    if (this.broken) return false;
    if (!event.hash || !event.prevHash)
      return this.breakAt(event, AUDIT_CHAIN_BREAK.MISSING_HASH);
    if (this.expectedPrev !== null && event.prevHash !== this.expectedPrev) {
      return this.breakAt(event, AUDIT_CHAIN_BREAK.PREV_MISMATCH);
    }
    if (computeEventHash(event, event.prevHash) !== event.hash) {
      return this.breakAt(event, AUDIT_CHAIN_BREAK.CONTENT_MISMATCH);
    }
    this.expectedPrev = event.hash;
    this.index += 1;
    return true;
  }

  result(): AuditChainVerification {
    return this.broken ?? { valid: true, checked: this.index, brokenAtIndex: -1 };
  }

  private breakAt(event: ActionEvent, reason: AuditChainBreak): boolean {
    this.broken = {
      valid: false,
      checked: this.index,
      brokenAtIndex: this.index,
      brokenEventId: event.id,
      brokenReason: reason,
    };
    return false;
  }
}

export function verifyAuditChain(events: ActionEvent[]): AuditChainVerification {
  const verifier = new AuditChainVerifier();
  for (const event of events) {
    if (!verifier.push(event)) break;
  }
  return verifier.result();
}
