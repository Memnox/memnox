import { shortDigest } from '../domain/digest';
import { minutesToMs, msToMinutes } from '../domain/time';
import { describeSpan, IN_MINUTES } from '../domain/duration-text';
/**
 * A lease on a path, so two agents in one repository stop being a coin flip. It locks
 * paths and never meaning, never blocks a read, always expires, and every wait is bounded.
 * The vocabulary matches `memnox-cloud/src/coordination/lease.ts`, so both halves agree.
 */

/** A pid nobody's agent runs as: init outlives everything and could never be reclaimed. */
export const NO_OWNER_PID = 1;

/** The parent, since a seam exits with its command and would abandon its own lease at once. */
export function holderPid(parent: number, self: number): number {
  return parent > NO_OWNER_PID ? parent : self;
}

/** Who holds a lease. The pid is this half's own: a dead owner is reclaimable. */
export interface LeaseHolder {
  /** The agent that took it: `claude-code`, `cursor`, `codex`. */
  agent: string;
  /** The run it belongs to, because a lease must never outlive its session. */
  sessionId: string;
  /** The process that took it, so a holder that died is reclaimed rather than waited on. */
  pid: number;
}

export interface LeaseTakeover {
  by: LeaseHolder;
  at: string;
  /** Why, in the taker's own words. Required: an override nobody can find is a slower allow. */
  reason: string;
}

export interface Lease {
  id: string;
  /** The normalized repository-relative prefix this holds. See `normalizeLeasePath`. */
  path: string;
  holder: LeaseHolder;
  takenAt: string;
  /** Required. There is no spelling for a lease that lasts for ever, by design. */
  expiresAt: string;
  /** What the holder has been doing, newest last, so a refusal says whether this is the same work. */
  activity: string[];
  releasedAt?: string;
  /** Kept for the life of the record rather than deleted with the lease. */
  takenOver?: LeaseTakeover;
}

export const LEASE_STATE = {
  /** In force: not released, not expired, not taken, and its holder is alive. */
  HELD: 'held',
  RELEASED: 'released',
  EXPIRED: 'expired',
  TAKEN_OVER: 'taken_over',
  /** The holder's process is gone. Reclaimable rather than waited on. */
  ABANDONED: 'abandoned',
} as const;

export type LeaseState = (typeof LEASE_STATE)[keyof typeof LEASE_STATE];

/** Bounded by construction: an agent's own tool call times out, so a longer wait is a hang. */
export const LEASE_MAX_WAIT_MS = 60_000;
/** Long enough for a task, short enough that a forgotten lease costs one lunch break. */
export const DEFAULT_LEASE_MINUTES = 30;
export const MAX_LEASE_MINUTES = 240;
/** Enough to say what the holder has been doing without the file growing without end. */
export const LEASE_MAX_ACTIVITY = 20;

/** Which state a lease is in. Liveness is a parameter, so a replay answers the same twice. */
export function leaseState(
  lease: Lease,
  moment: string,
  alive: (pid: number) => boolean,
): LeaseState {
  if (lease.takenOver !== undefined) return LEASE_STATE.TAKEN_OVER;
  if (lease.releasedAt !== undefined) return LEASE_STATE.RELEASED;
  if (moment >= lease.expiresAt) return LEASE_STATE.EXPIRED;
  if (!alive(lease.holder.pid)) return LEASE_STATE.ABANDONED;
  return LEASE_STATE.HELD;
}

/** The moment is passed in, so a replay a month later gives the same answer. */
export function leasesInForce(
  leases: readonly Lease[],
  moment: string,
  alive: (pid: number) => boolean,
): Lease[] {
  return leases.filter((lease) => leaseState(lease, moment, alive) === LEASE_STATE.HELD);
}

/**
 * One repository-relative, forward-slashed spelling, so two agents cannot both hold a path.
 * The empty string is the root; null is a path that walks out of the tree.
 */
export function normalizeLeasePath(raw: string): string | null {
  const segments: string[] = [];
  for (const segment of raw.replace(/\\/g, '/').trim().split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') return null;
    segments.push(segment);
  }
  return segments.join('/');
}

/**
 * Whether one path is or contains the other, on segment boundaries, so `src/billing`
 * holds `src/billing/invoice.ts` and not `src/billing-legacy`.
 */
export function conflicts(held: string, wanted: string): boolean {
  return contains(held, wanted) || contains(wanted, held);
}

function contains(outer: string, inner: string): boolean {
  if (outer === '') return true;
  if (inner === outer) return true;
  return inner.startsWith(`${outer}/`);
}

/**
 * The same holder asking again, which is a renewal rather than a collision. A session
 * that lost its lease id, after a crash or a re-exec, must not wait on itself.
 */
export function sameHolder(a: LeaseHolder, b: LeaseHolder): boolean {
  return a.agent === b.agent && a.sessionId === b.sessionId;
}

/** How long a waiter waits, never past the lease's expiry nor the ceiling. */
export function waitFor(
  lease: Lease,
  moment: string,
  ceiling = LEASE_MAX_WAIT_MS,
): number {
  const remaining = Date.parse(lease.expiresAt) - Date.parse(moment);
  if (remaining <= 0) return 0;
  return Math.min(remaining, ceiling);
}

/** What a writer asks for: a path, who is asking, and optionally how long and why. */
export interface LeaseRequest {
  path: string;
  holder: LeaseHolder;
  minutes?: number;
  activity?: string;
}

// Clamped rather than refused, so an agent asking for a day gets the maximum instead of an error.
function clampMinutes(minutes: number): number {
  return Math.min(Math.max(minutes, 1), MAX_LEASE_MINUTES);
}

function expiryAfter(now: string, minutes: number): string {
  return new Date(Date.parse(now) + minutesToMs(clampMinutes(minutes))).toISOString();
}

export function leaseFor(request: LeaseRequest, now: string): Lease {
  const { path, holder, activity } = request;
  return {
    // The path too, or two paths one command writes in the same millisecond share a file.
    id: `lse_${Date.parse(now).toString(36)}_${holder.pid.toString(36)}_${shortDigest(path).slice(0, 8)}`,
    path,
    holder,
    takenAt: now,
    expiresAt: expiryAfter(now, request.minutes ?? DEFAULT_LEASE_MINUTES),
    activity: activity === undefined ? [] : [activity],
  };
}

/** Kept for another window, never shorter, so an editor's five minutes cannot cut a shell's half hour. */
export function extendedTo(lease: Lease, now: string, minutes: number): Lease {
  const wanted = expiryAfter(now, minutes);
  return wanted > lease.expiresAt ? { ...lease, expiresAt: wanted } : lease;
}

/** Newest last, bounded, so the file cannot grow without end on a long session. */
export function withActivity(lease: Lease, note: string): Lease {
  if (note.trim() === '') return lease;
  const kept = [...lease.activity, note].slice(-LEASE_MAX_ACTIVITY);
  return { ...lease, activity: kept };
}

/** The line a refusal is built from: who, how long, and what they have been doing. */
export function describeLease(lease: Lease, moment: string): string {
  const minutes = Math.max(
    0,
    msToMinutes(Date.parse(moment) - Date.parse(lease.takenAt)),
  );
  const held = minutes < 1 ? 'just now' : describeSpan(minutesToMs(minutes), IN_MINUTES);
  const path = lease.path === '' ? 'the repository root' : lease.path;
  return `${lease.holder.agent} has ${path} (${held}, session ${lease.holder.sessionId})`;
}
