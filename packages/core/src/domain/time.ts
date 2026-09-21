/**
 * Every conversion between a stretch of time and milliseconds, in one place. Named `xToY`
 * so a local called `minutes` cannot shadow the conversion it is about to use.
 */
export const SECOND_MS = 1_000;
export const MINUTE_MS = 60 * SECOND_MS;
export const HOUR_MS = 60 * MINUTE_MS;
export const HOURS_IN_A_DAY = 24;
export const DAY_MS = HOURS_IN_A_DAY * HOUR_MS;

export function secondsToMs(count: number): number {
  return count * SECOND_MS;
}

export function minutesToMs(count: number): number {
  return count * MINUTE_MS;
}

export function daysToMs(count: number): number {
  return count * DAY_MS;
}

/** Rounded, for a span a person reads. */
export function msToSeconds(span: number): number {
  return Math.round(span / SECOND_MS);
}

/** Rounded, for a span a person reads. */
export function msToMinutes(span: number): number {
  return Math.round(span / MINUTE_MS);
}

/** Floored, for "how long has this been true", which must never round up past now. */
export function msToWholeMinutes(span: number): number {
  return Math.floor(span / MINUTE_MS);
}
