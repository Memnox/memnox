import { createHash } from 'node:crypto';

/** Short enough to read in a terminal, long enough that a collision is not a worry. */
const DIGEST_LENGTH = 16;

/** For a name a person reads beside other text, where the full digest would bury it. */
const SHORT_DIGEST_LENGTH = 8;

/**
 * The one way anything in this product records a payload. What is stored is this and
 * never the value: a ledger holding what an agent read is the thing worth stealing.
 */
export function digest(payload: string): string {
  return hashed(payload, DIGEST_LENGTH);
}

/**
 * The same hash, cut to something a person can read in a filename or a sentence. A second
 * function rather than a length argument, so every caller uses the same length.
 */
export function shortDigest(payload: string): string {
  return hashed(payload, SHORT_DIGEST_LENGTH);
}

function hashed(payload: string, length: number): string {
  return createHash('sha256').update(payload).digest('hex').slice(0, length);
}
