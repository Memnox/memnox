const MINUTES_PER_HOUR = 60;
const MS_PER_MINUTE = 60_000;
const HOURS_PER_DAY = 24;
const DAYS_PER_WEEK = 7;

/** A recurring wall-clock window. Offsets are fixed minutes from UTC — no zone database. */
export interface TimeWindow {
  /** 0 = Sunday … 6 = Saturday. Omitted matches every day. */
  days?: number[];
  /** Inclusive, 0–23. */
  startHour: number;
  /** Exclusive, 1–24. A start after the end wraps past midnight. */
  endHour: number;
  /** Minutes from UTC; omitted is UTC. */
  utcOffsetMinutes?: number;
}

export function isValidTimeWindow(window: TimeWindow): boolean {
  const hoursValid =
    Number.isInteger(window.startHour) &&
    Number.isInteger(window.endHour) &&
    window.startHour >= 0 &&
    window.startHour < HOURS_PER_DAY &&
    window.endHour > 0 &&
    window.endHour <= HOURS_PER_DAY;
  const daysValid =
    window.days === undefined ||
    (window.days.length > 0 &&
      window.days.every(
        (day) => Number.isInteger(day) && day >= 0 && day < DAYS_PER_WEEK,
      ));
  return hoursValid && daysValid;
}

/** Deterministic: the instant is an argument, never read from the clock here. */
export function matchesTimeWindow(window: TimeWindow, at: Date): boolean {
  const shifted = new Date(at.getTime() + (window.utcOffsetMinutes ?? 0) * MS_PER_MINUTE);
  const hour = shifted.getUTCHours() + shifted.getUTCMinutes() / MINUTES_PER_HOUR;
  const wraps = window.startHour >= window.endHour;

  const inHours = wraps
    ? hour >= window.startHour || hour < window.endHour
    : hour >= window.startHour && hour < window.endHour;
  if (!inHours) return false;
  if (!window.days) return true;

  // An overnight window belongs to the day it started on.
  const day = shifted.getUTCDay();
  const startedYesterday = wraps && hour < window.endHour;
  const effectiveDay = startedYesterday ? (day - 1 + DAYS_PER_WEEK) % DAYS_PER_WEEK : day;
  return window.days.includes(effectiveDay);
}

export function matchesAnyTimeWindow(
  windows: readonly TimeWindow[] | undefined,
  at: Date | undefined,
): boolean {
  if (!windows || windows.length === 0) return true;
  // Windows scope restrictions, so an unknown instant applies the rule rather than skipping it.
  if (!at) return true;
  return windows.some((window) => matchesTimeWindow(window, at));
}
