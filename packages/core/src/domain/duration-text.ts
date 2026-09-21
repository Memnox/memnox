import { HOUR_MS, MINUTE_MS, SECOND_MS } from './time';

/**
 * A span of time as a person reads it, in the largest unit that still says something,
 * so "5400s" and "90 min" never reach a screen.
 */

/** One unit a span may be read in, used while the span is under `belowMs`. */
export interface SpanUnit {
  unitMs: number;
  suffix: string;
  belowMs?: number;
}

/** Minutes, and nothing coarser: a lease is never held long enough to need hours. */
export const IN_MINUTES: readonly SpanUnit[] = [{ unitMs: MINUTE_MS, suffix: ' min' }];

/** Minutes under an hour, hours past it. */
export const IN_MINUTES_THEN_HOURS: readonly SpanUnit[] = [
  { unitMs: MINUTE_MS, suffix: ' min', belowMs: HOUR_MS },
  { unitMs: HOUR_MS, suffix: 'h' },
];

/** Seconds under a minute and a half, minutes under an hour and a half, then hours. */
export const IN_SECONDS_THEN_MINUTES_THEN_HOURS: readonly SpanUnit[] = [
  { unitMs: SECOND_MS, suffix: 's', belowMs: 90 * SECOND_MS },
  { unitMs: MINUTE_MS, suffix: 'm', belowMs: 90 * MINUTE_MS },
  { unitMs: HOUR_MS, suffix: 'h' },
];

/** The span in the first unit it sits under, rounded to a whole number of it. */
export function describeSpan(spanMs: number, units: readonly SpanUnit[]): string {
  const unit =
    units.find((each) => each.belowMs === undefined || spanMs < each.belowMs) ??
    units[units.length - 1];
  if (unit === undefined) return `${spanMs}ms`;
  return `${Math.round(spanMs / unit.unitMs)}${unit.suffix}`;
}
