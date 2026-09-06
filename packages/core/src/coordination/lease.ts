/**
 * A lease on a path, so two agents in one repository stop being a coin flip.
 *
 * This is the first thing here that blocks work for a reason that is not safety, and
 * that changes what a mistake costs. A policy deny is wrong occasionally and the cost
 * is an argument; a wrong lease is wrong silently and the cost is somebody's afternoon.
 * So four rules hold, and every one of them is enforced in this file rather than left
 * to the callers: it locks paths and never meaning, it never blocks a read, every lease
 * expires, and a wait is always bounded.
 *
 * The cloud holds the half a laptop structurally cannot: two machines on one
 * repository need the register somewhere both can see. This half needs no account and
 * no network, so the vocabulary matches `memnox-cloud/src/coordination/lease.ts`
 * deliberately — a lease taken here and a lease read there must mean the same thing.
 */

/** Who holds a lease. The pid is this half's own: a dead owner is reclaimable. */
export interface LeaseHolder {
  /** The agent that took it: `claude-code`, `cursor`, `codex`. */
  agent: string;
  /** The run it belongs to. A lease outliving its session is what rule 3 forbids. */
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
  /**
   * What the holder has been doing with it, newest last. This is the half of a refusal
   * that ends the argument: "cursor has src/billing" is a fact, "cursor wrote
   * invoice.ts and ran the billing tests" is the sentence that tells the second agent
   * whether it is about to do the same work twice.
   */
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

/**
 * Which of the five a lease is in, asked here and never by comparing dates at a call
 * site: that is five conditions and the last two are the ones that get forgotten.
 *
 * Liveness is passed in rather than read, so this stays pure and a replay gives the
 * same answer twice.
 */
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
 * The path a lease is taken on, in one shape, so two agents naming the same directory
 * differently cannot both hold it.
 *
 * Repository-relative and forward-slashed, because that is the only spelling two
 * machines agree on. The empty string is the repository root, which is a real lease:
 * that is what a refactor of the whole tree takes.
 *
 * `null` for anything a prefix comparison could not be trusted on — a path that walks
 * out of the tree is one whose collisions this file cannot reason about.
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
 * Whether two paths collide: one is the other, or one contains the other.
 *
 * Compared on segment boundaries rather than as strings, so `src/billing` holds
 * `src/billing/invoice.ts` and does not hold `src/billing-legacy`. A plain `startsWith`
 * would take the second one too, and a lease that silently covers a directory nobody
 * named is rule 1 broken from the inside.
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
 * that lost its lease id — a crashed process, a re-exec — must not wait on itself.
 */
export function sameHolder(a: LeaseHolder, b: LeaseHolder): boolean {
  return a.agent === b.agent && a.sessionId === b.sessionId;
}

/**
 * How long a waiter should wait before giving up, never past the lease's own expiry and
 * never past the ceiling. Rule 4: the waiting happens on the side that can give up.
 */
export function waitFor(
  lease: Lease,
  moment: string,
  ceiling = LEASE_MAX_WAIT_MS,
): number {
  const remaining = Date.parse(lease.expiresAt) - Date.parse(moment);
  if (remaining <= 0) return 0;
  return Math.min(remaining, ceiling);
}

export function leaseFor(
  path: string,
  holder: LeaseHolder,
  now: string,
  minutes: number = DEFAULT_LEASE_MINUTES,
  activity?: string,
): Lease {
  /* Clamped rather than refused: an agent asking for a day gets four hours, which
     keeps rule 3 without failing the call somebody was in the middle of. */
  const held = Math.min(Math.max(minutes, 1), MAX_LEASE_MINUTES);
  return {
    id: `lse_${Date.parse(now).toString(36)}_${holder.pid.toString(36)}`,
    path,
    holder,
    takenAt: now,
    expiresAt: new Date(Date.parse(now) + held * 60_000).toISOString(),
    activity: activity === undefined ? [] : [activity],
  };
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
    Math.round((Date.parse(moment) - Date.parse(lease.takenAt)) / 60_000),
  );
  const held = minutes < 1 ? 'just now' : `${minutes} min`;
  const path = lease.path === '' ? 'the repository root' : lease.path;
  return `${lease.holder.agent} has ${path} (${held}, session ${lease.holder.sessionId})`;
}
