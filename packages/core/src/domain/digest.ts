import { createHash } from 'node:crypto';

/** Short enough to read in a terminal, long enough that a collision is not a worry. */
const DIGEST_LENGTH = 16;

/**
 * The one way anything in this product records a payload. What is stored is this and
 * never the value: a ledger holding what an agent read is the thing worth stealing.
 */
export function digest(payload: string): string {
  return createHash('sha256').update(payload).digest('hex').slice(0, DIGEST_LENGTH);
}
