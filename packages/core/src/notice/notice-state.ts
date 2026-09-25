/**
 * The two small records noticing keeps: what an agent has done before, and what a session
 * has taken and been told. Pure and bounded, so a seam reads one file and never the ledger.
 */
import { digest } from '../domain/digest';

/** Digests of what an agent has done, each with when it last did it. */
export interface SeenSet {
  entries: Record<string, string>;
}

/** Something worth having, taken in this session, and when. */
export interface Acquired {
  step: string;
  at: string;
}

/** A tool result that read like instructions, and until when the session stays suspect. */
export interface Taint {
  /** The server and tool whose result it was, as a reason names it. */
  source: string;
  at: string;
  until: string;
}

export interface SessionSignals {
  acquired: Acquired[];
  taint?: Taint;
  /** Reads outside this machine this session, before it changed anything there. */
  outsideReads?: number;
  /** Set at the first change outside, so the turn is asked about once. */
  outsideChanged?: boolean;
}

export function emptySeen(): SeenSet {
  return { entries: {} };
}

export function emptySignals(): SessionSignals {
  return { acquired: [] };
}

/** A digest rather than the key, so the file is not a history of every path and host. */
export function seenKey(key: string): string {
  return digest(key);
}

/** Never done, or last done longer ago than the history reaches. */
export function isNovel(seen: SeenSet, key: string, input: WindowInput): boolean {
  const last = seen.entries[seenKey(key)];
  if (last === undefined) return true;
  return Date.parse(input.now) - Date.parse(last) > input.windowMs;
}

export interface WindowInput {
  now: string;
  windowMs: number;
}

/** Remembered with the oldest let go past the bound, so the file never grows past it. */
export function remember(seen: SeenSet, key: string, at: string, most: number): SeenSet {
  const entries = { ...seen.entries, [seenKey(key)]: at };
  const keys = Object.keys(entries);
  if (keys.length <= most) return { entries };
  const newest = keys
    .sort((a, b) => Date.parse(entries[b] ?? '') - Date.parse(entries[a] ?? ''))
    .slice(0, most);
  return {
    entries: Object.fromEntries(newest.map((each) => [each, entries[each] ?? at])),
  };
}

/** A new acquisition kept, the oldest past the bound dropped. */
export function rememberAcquired(
  signals: SessionSignals,
  acquired: Acquired,
  most: number,
): SessionSignals {
  return { ...signals, acquired: [...signals.acquired, acquired].slice(-most) };
}

/** What this session took inside the window, oldest first. */
export function acquiredWithin(signals: SessionSignals, input: WindowInput): Acquired[] {
  const now = Date.parse(input.now);
  return signals.acquired.filter((each) => now - Date.parse(each.at) <= input.windowMs);
}

/** The taint in force now, or null when there is none or it has lapsed. */
export function taintInForce(signals: SessionSignals, now: string): Taint | null {
  const taint = signals.taint;
  if (taint === undefined) return null;
  return Date.parse(now) <= Date.parse(taint.until) ? taint : null;
}

/** A taint still on file whose window has passed, so its lapse can be recorded once. */
export function lapsedTaint(signals: SessionSignals, now: string): Taint | null {
  const taint = signals.taint;
  if (taint === undefined) return null;
  return Date.parse(now) > Date.parse(taint.until) ? taint : null;
}

export function withTaint(signals: SessionSignals, taint: Taint): SessionSignals {
  return { ...signals, taint };
}

export function withoutTaint(signals: SessionSignals): SessionSignals {
  return { acquired: signals.acquired };
}
