import { daysToMs } from '@memnox/core';

/**
 * The start of a look-back window typed in days, read forgivingly: where `since` in
 * `duration.ts` refuses a bad value, these screens fall back to their own default.
 */

/** `raw` is read as whole days, so `30d` is 30 and anything without a leading number is `fallbackDays`. */
export function resolveWindowStart(raw: string, now: Date, fallbackDays: number): string {
  const typed = Number.parseInt(raw, 10);
  const days = Number.isNaN(typed) ? fallbackDays : typed;
  return new Date(now.getTime() - daysToMs(days)).toISOString();
}
