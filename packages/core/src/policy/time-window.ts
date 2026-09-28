import { HOUR_MS, HOURS_IN_A_DAY, MINUTE_MS, minutesToMs } from '../domain/time';

/**
 * A rule that only applies at certain hours, evaluated against a moment passed in. No
 * zone database, because a window is a fact about a working day, not civil time.
 */
const MINUTES_PER_HOUR = HOUR_MS / MINUTE_MS;
const DAYS_PER_WEEK = 7;
const MAX_UTC_OFFSET_MINUTES = 14 * MINUTES_PER_HOUR;
const MIN_UTC_OFFSET_MINUTES = -MAX_UTC_OFFSET_MINUTES;

/** A recurring wall-clock window. Offsets are fixed minutes from UTC, with no zone database. */
export interface TimeWindow {
  /** 0 = Sunday … 6 = Saturday. Omitted matches every day. */
  days?: number[];
  /** Inclusive, 0 to 23. */
  startHour: number;
  /** Exclusive, 1 to 24. A start after the end wraps past midnight. */
  endHour: number;
  /** Minutes from UTC; omitted is UTC. */
  utcOffsetMinutes?: number;
}

export function isValidTimeWindow(window: unknown): window is TimeWindow {
  if (!window || typeof window !== 'object' || Array.isArray(window)) return false;
  // The object boundary is checked above; each field stays unknown until validated.
  const raw = window as Record<string, unknown>;
  const startHour = raw['startHour'];
  const endHour = raw['endHour'];
  const days = raw['days'];
  const utcOffsetMinutes = raw['utcOffsetMinutes'];
  const hoursValid =
    typeof startHour === 'number' &&
    typeof endHour === 'number' &&
    Number.isInteger(startHour) &&
    Number.isInteger(endHour) &&
    startHour >= 0 &&
    startHour < HOURS_IN_A_DAY &&
    endHour > 0 &&
    endHour <= HOURS_IN_A_DAY;
  const daysValid =
    days === undefined ||
    (Array.isArray(days) &&
      days.length > 0 &&
      days.every(
        (day: unknown) =>
          typeof day === 'number' &&
          Number.isInteger(day) &&
          day >= 0 &&
          day < DAYS_PER_WEEK,
      ));
  const offsetValid =
    utcOffsetMinutes === undefined ||
    (typeof utcOffsetMinutes === 'number' &&
      Number.isInteger(utcOffsetMinutes) &&
      utcOffsetMinutes >= MIN_UTC_OFFSET_MINUTES &&
      utcOffsetMinutes <= MAX_UTC_OFFSET_MINUTES);
  return hoursValid && daysValid && offsetValid;
}

/** Deterministic: the instant is an argument, never read from the clock here. */
export function matchesTimeWindow(window: TimeWindow, at: Date): boolean {
  const shifted = new Date(at.getTime() + minutesToMs(window.utcOffsetMinutes ?? 0));
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
