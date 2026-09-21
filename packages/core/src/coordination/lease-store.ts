import { mkdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { MEMNOX_HOME } from '../config/config';
import { JsonRecordDir } from '../store/json-records';
import {
  conflicts,
  DEFAULT_LEASE_MINUTES,
  extendedTo,
  leasesInForce,
  leaseFor,
  NO_OWNER_PID,
  sameHolder,
  withActivity,
  type Lease,
  type LeaseHolder,
  type LeaseRequest,
} from './lease';

/**
 * The register of who holds which path, on one machine. Nothing here waits: a collision
 * is answered with the holder, and the caller decides.
 */
export const LEASE_DIR = 'leases';
/** The mutex is held for a directory read and one write. Anything longer is a crash. */
const MUTEX_STALE_MS = 5_000;
const MUTEX_RETRY_MS = 25;
const MUTEX_ATTEMPTS = 200;

export function leaseDirFor(home: string): string {
  return join(home, MEMNOX_HOME, LEASE_DIR);
}

export const LEASE_OUTCOME = {
  TAKEN: 'taken',
  /** Somebody else holds a path that overlaps this one. */
  HELD_BY_ANOTHER: 'held_by_another',
  /** Not a path a prefix comparison can be trusted on: see `normalizeLeasePath`. */
  UNUSABLE_PATH: 'unusable_path',
  NOT_FOUND: 'not_found',
  /** Released, expired, abandoned, or already taken from its holder. */
  NOT_HELD: 'not_held',
  NOT_YOURS: 'not_yours',
} as const;

export type LeaseOutcome = (typeof LEASE_OUTCOME)[keyof typeof LEASE_OUTCOME];

export type TakeResult =
  | { outcome: typeof LEASE_OUTCOME.TAKEN; lease: Lease }
  | {
      outcome: typeof LEASE_OUTCOME.HELD_BY_ANOTHER;
      // The lease in the way, because a refusal that will not say who gets forced every time.
      holding: Lease;
    }
  | { outcome: typeof LEASE_OUTCOME.UNUSABLE_PATH };

export type LeaseChangeResult =
  | { outcome: typeof LEASE_OUTCOME.TAKEN; lease: Lease }
  | { outcome: typeof LEASE_OUTCOME.NOT_FOUND }
  | { outcome: typeof LEASE_OUTCOME.NOT_YOURS };

/** Whether a process is still there. Signal 0 asks without sending anything. */
export function processAlive(pid: number): boolean {
  // init is nobody's agent and never dies, so a lease recorded against it is reclaimable.
  if (pid <= NO_OWNER_PID) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means it exists and belongs to somebody else, which is still alive.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Serialized through a directory mutex rather than an atomic create, because exclusion is
 * over overlapping paths: two files for `src/billing` and `src/billing/invoice.ts` both win.
 */
export class LeaseRegistry {
  private readonly records: JsonRecordDir<Lease>;

  constructor(
    private readonly home: string,
    private readonly alive: (pid: number) => boolean = processAlive,
  ) {
    this.records = new JsonRecordDir<Lease>(leaseDirFor(home));
  }

  async all(): Promise<Lease[]> {
    const found = await this.records.all();
    return found.sort((a, b) => a.takenAt.localeCompare(b.takenAt));
  }

  /** Every lease actually in force: not expired, not released, holder still alive. */
  async held(moment: string): Promise<Lease[]> {
    return leasesInForce(await this.all(), moment, this.alive);
  }

  /** Null when released and cleared or never taken, which both mean nobody holds it. */
  read(id: string): Promise<Lease | null> {
    return this.records.read(id);
  }

  async take(request: LeaseRequest, now: string): Promise<TakeResult> {
    return this.exclusively(async () => {
      const standing = leasesInForce(await this.all(), now, this.alive);
      const overlapping = standing.filter((lease) => conflicts(lease.path, request.path));
      const blocking = overlapping.find(
        (lease) => !sameHolder(lease.holder, request.holder),
      );
      if (blocking !== undefined) {
        return { outcome: LEASE_OUTCOME.HELD_BY_ANOTHER, holding: blocking };
      }
      // The same session asking again renews, so ten files written make one lease.
      const mine = overlapping.find((lease) => sameHolder(lease.holder, request.holder));
      const lease =
        mine === undefined ? leaseFor(request, now) : renewed(mine, request, now);
      await this.write(lease);
      return { outcome: LEASE_OUTCOME.TAKEN, lease };
    });
  }

  /** Taking it anyway. A row, never a silent allow: the reason rides with the record. */
  async takeOver(
    id: string,
    by: LeaseHolder,
    reason: string,
    now: string,
  ): Promise<LeaseChangeResult> {
    return this.exclusively(async () => {
      const held = await this.read(id);
      if (held === null) return { outcome: LEASE_OUTCOME.NOT_FOUND };
      await this.write({ ...held, takenOver: { by, at: now, reason } });

      const lease = leaseFor({ path: held.path, holder: by }, now);
      await this.write(lease);
      return { outcome: LEASE_OUTCOME.TAKEN, lease };
    });
  }

  async release(
    id: string,
    holder: LeaseHolder,
    now: string,
  ): Promise<LeaseChangeResult> {
    return this.exclusively(async () => {
      const lease = await this.read(id);
      if (lease === null) return { outcome: LEASE_OUTCOME.NOT_FOUND };
      if (!sameHolder(lease.holder, holder)) return { outcome: LEASE_OUTCOME.NOT_YOURS };
      const released = { ...lease, releasedAt: now };
      await this.write(released);
      return { outcome: LEASE_OUTCOME.TAKEN, lease: released };
    });
  }

  /** Everything a session holds, let go at once, since an ended session holds nothing. */
  async releaseSession(sessionId: string, now: string): Promise<Lease[]> {
    return this.exclusively(async () => {
      const released: Lease[] = [];
      for (const lease of await this.all()) {
        if (lease.holder.sessionId !== sessionId) continue;
        if (lease.releasedAt !== undefined) continue;
        const done = { ...lease, releasedAt: now };
        await this.write(done);
        released.push(done);
      }
      return released;
    });
  }

  /** Everything a session holds, kept for another window because it is still working. */
  async renewSession(sessionId: string, now: string, minutes: number): Promise<number> {
    return this.exclusively(async () => {
      let renewed = 0;
      for (const lease of leasesInForce(await this.all(), now, this.alive)) {
        if (lease.holder.sessionId !== sessionId) continue;
        await this.write(extendedTo(lease, now, minutes));
        renewed += 1;
      }
      return renewed;
    });
  }

  /** Records of leases nobody holds any more. Kept until asked, then gone. */
  async forget(moment: string): Promise<number> {
    return this.exclusively(async () => {
      let dropped = 0;
      for (const lease of await this.all()) {
        if (leasesInForce([lease], moment, this.alive).length > 0) continue;
        await this.records.remove(lease.id);
        dropped += 1;
      }
      return dropped;
    });
  }

  // Atomic, so a lease read mid renewal never reads as absent and gets taken.
  private async write(lease: Lease): Promise<void> {
    await this.records.write(lease.id, lease);
  }

  /**
   * One writer at a time, across processes, since `mkdir` is atomic everywhere. A lock
   * older than any honest critical section was left by a crash and is reclaimed.
   */
  private async exclusively<T>(work: () => Promise<T>): Promise<T> {
    const lock = join(leaseDirFor(this.home), '.lock');
    await mkdir(leaseDirFor(this.home), { recursive: true, mode: 0o700 });

    for (let attempt = 0; attempt < MUTEX_ATTEMPTS; attempt += 1) {
      try {
        await mkdir(lock);
        try {
          return await work();
        } finally {
          await rm(lock, { recursive: true, force: true });
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        await this.reclaimStale(lock);
        await new Promise((resolve) => setTimeout(resolve, MUTEX_RETRY_MS));
      }
    }
    // Five seconds of contention is a bug, and proceeding without the mutex would corrupt the register.
    throw new Error('could not take the lease lock; run `memnox doctor`');
  }

  private async reclaimStale(lock: string): Promise<void> {
    try {
      const { mtimeMs } = await stat(lock);
      if (Date.now() - mtimeMs > MUTEX_STALE_MS) {
        await rm(lock, { recursive: true, force: true });
      }
    } catch {
      // Gone between the failed mkdir and here, which is the outcome we wanted anyway.
    }
  }
}

function renewed(lease: Lease, request: LeaseRequest, now: string): Lease {
  const noted =
    request.activity === undefined ? lease : withActivity(lease, request.activity);
  return extendedTo(noted, now, request.minutes ?? DEFAULT_LEASE_MINUTES);
}
