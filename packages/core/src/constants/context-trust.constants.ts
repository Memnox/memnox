/** Trust is set by whoever supplied the block. A type cannot be talked around. */
export const CONTEXT_TRUST = {
  TRUSTED: 'trusted',
  UNTRUSTED: 'untrusted',
  UNKNOWN: 'unknown',
} as const;

export type ContextTrust = (typeof CONTEXT_TRUST)[keyof typeof CONTEXT_TRUST];

/** Anything not asserted trusted is treated as untrusted when authority is at stake. */
export const AUTHORITATIVE_TRUST: readonly ContextTrust[] = [CONTEXT_TRUST.TRUSTED];

export const CONTEXT_TRUST_REASON = {
  STRIPPED:
    'untrusted context carried instruction-shaped content; it was recorded, not obeyed',
} as const;
