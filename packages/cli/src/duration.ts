import { HOUR_MS, MINUTE_MS, SECOND_MS, DAY_MS } from '@memnox/core';

/** Every flag that names a stretch of time is read here, so each accepts the same forms. */

export { DAY_MS } from '@memnox/core';

const UNIT_MS = { s: SECOND_MS, m: MINUTE_MS, h: HOUR_MS, d: DAY_MS } as const;

type DurationUnit = keyof typeof UNIT_MS;

/** The shape every flag accepts, said once so every error sentence says the same thing. */
const FORMS = '30m, 2h or 7d';

const DURATION = /^(\d+)\s*([smhd])?$/;

/**
 * `bare` is what a number with no unit means, and it differs per flag on purpose:
 * `--for 30` is half an hour and `--days 30` is a month.
 */
function durationMs(raw: string, flag: string, bare: DurationUnit): number {
  const match = DURATION.exec(raw.trim());
  if (match === null) throw new Error(`${flag} takes ${FORMS}. Got "${raw}".`);
  const size = Number(match[1]);
  if (!Number.isInteger(size) || size <= 0) {
    throw new Error(`${flag} takes ${FORMS}. Got "${raw}".`);
  }
  // Cast is safe: the capture group is the unit alternation itself.
  const unit = match[2] === undefined ? bare : (match[2] as DurationUnit);
  return size * UNIT_MS[unit];
}

/** Whole days, for the flags that walk history a day at a time. */
export function windowDays(raw: string, flag: string): number {
  const ms = durationMs(raw, flag, 'd');
  if (ms % DAY_MS !== 0) {
    throw new Error(`${flag} takes whole days, like 7d. Got "${raw}".`);
  }
  return ms / DAY_MS;
}

/** Minutes, for the flags that hold something open rather than look back. */
export function minutesFrom(raw: string, flag: string): number {
  return durationMs(raw, flag, 'm') / UNIT_MS.m;
}

/**
 * A point in the past. Relative first, because nobody types an ISO timestamp at a
 * terminal, but one pasted from a log still has to work.
 */
export function since(raw: string, now: Date, flag = '--since'): string {
  if (DURATION.test(raw.trim())) {
    return new Date(now.getTime() - durationMs(raw, flag, 'd')).toISOString();
  }
  const parsed = Date.parse(raw);
  if (Number.isNaN(parsed)) {
    throw new Error(`${flag} takes 30m, 2h, 7d or an ISO timestamp. Got "${raw}".`);
  }
  return new Date(parsed).toISOString();
}
