/**
 * Money on a screen, rounded to cents, because `0.30000000000000004` in a report costs
 * the rest of it its credibility. Nothing here prices anything.
 */
const CENTS_IN_A_UNIT = 100;

/** Still in whole units, rounded to two decimals. */
export function roundToCents(amount: number): number {
  return Math.round(amount * CENTS_IN_A_UNIT) / CENTS_IN_A_UNIT;
}
