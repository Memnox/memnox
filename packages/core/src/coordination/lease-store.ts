import { mkdir, readFile, readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { MEMNOX_HOME } from '../config/config';
import { writeJsonAtomic } from '../store/atomic-file';
import {
  conflicts,
  leasesInForce,
  leaseFor,
  sameHolder,
  withActivity,
  type Lease,
  type LeaseHolder,
} from './lease';

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
      /* The lease in the way, returned rather than hidden behind a bare refusal: "who
         holds it and what have they been doing" is the sentence that ends the argument,
         and a refusal that will not say is one people work around by forcing every time. */
      holding: Lease;
    }
  | { outcome: typeof LEASE_OUTCOME.UNUSABLE_PATH };

export type LeaseChangeResult =
  | { outcome: typeof LEASE_OUTCOME.TAKEN; lease: Lease }
  | { outcome: typeof LEASE_OUTCOME.NOT_FOUND }
  | { outcome: typeof LEASE_OUTCOME.NOT_YOURS };

/** Whether a process is still there. Signal 0 asks without sending anything. */
export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means it exists and belongs to somebody else, which is still alive.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * The register of who holds what, on one machine.
 *
 * Taking is serialized through a directory mutex rather than through one atomic file
 * create, because exclusion here is over *overlapping* paths and not over equal names:
 * `src/billing` and `src/billing/invoice.ts` are different file names and the same
 * lease. Two processes that each created their own file would both believe they won.
 *
 * Nothing here waits and nothing here blocks. A collision is answered with the holder;
 * the caller decides whether to wait, take it anyway, or do something else — that is
 * the side that can give up when the agent's own tool call times out.
 */
export class LeaseRegistry {
  constructor(
    private readonly home: string,
    private readonly alive: (pid: number) => boolean = processAlive,
  ) {}

  async all(): Promise<Lease[]> {
    let names: string[];
    try {
      names = await readdir(leaseDirFor(this.home));
    } catch {
      // Nothing has ever been leased here, which is the ordinary case.
      return [];
    }

    const found: Lease[] = [];
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      const lease = await this.read(name.slice(0, -5));
      if (lease !== null) found.push(lease);
    }
    return found.sort((a, b) => a.takenAt.localeCompare(b.takenAt));
  }

  /** Every lease actually in force: not expired, not released, holder still alive. */
  async held(moment: string): Promise<Lease[]> {
    return leasesInForce(await this.all(), moment, this.alive);
  }

  async read(id: string): Promise<Lease | null> {
    try {
      return JSON.parse(await readFile(this.pathFor(id), 'utf8')) as Lease;
    } catch {
      // Released and cleared, or never taken. Both are "nobody holds it".
      return null;
    }
  }

  async take(
    path: string,
    holder: LeaseHolder,
    now: string,
    minutes?: number,
    activity?: string,
  ): Promise<TakeResult> {
    return this.exclusively(async () => {
      const standing = leasesInForce(await this.all(), now, this.alive);
      const blocking = standing.find(
        (lease) => conflicts(lease.path, path) && !sameHolder(lease.holder, holder),
      );
      if (blocking !== undefined) {
        return { outcome: LEASE_OUTCOME.HELD_BY_ANOTHER, holding: blocking };
      }

      /* The same session asking again is a renewal, not a second lease. One session
         writing ten files must end up holding one lease rather than ten. */
      const mine = standing.find(
        (lease) => sameHolder(lease.holder, holder) && conflicts(lease.path, path),
      );
      if (mine !== undefined) {
        const noted = activity === undefined ? mine : withActivity(mine, activity);
        await this.write(noted);
        return { outcome: LEASE_OUTCOME.TAKEN, lease: noted };
      }

      const lease = leaseFor(path, holder, now, minutes, activity);
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

      const lease = leaseFor(held.path, by, now);
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

  /**
   * Everything a session holds, let go at once. Rule 3 from the other end: a session
   * that ended cannot still be holding a path, whatever its lease said about expiry.
   */
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

  /** Records of leases nobody holds any more. Kept until asked, then gone. */
  async forget(moment: string): Promise<number> {
    return this.exclusively(async () => {
      let dropped = 0;
      for (const lease of await this.all()) {
        if (leasesInForce([lease], moment, this.alive).length > 0) continue;
        await rm(this.pathFor(lease.id), { force: true });
        dropped += 1;
      }
      return dropped;
    });
  }

  private pathFor(id: string): string {
    return join(leaseDirFor(this.home), `${id}.json`);
  }

  private async write(lease: Lease): Promise<void> {
    await mkdir(leaseDirFor(this.home), { recursive: true, mode: 0o700 });
    /* Atomic: a lease read while it is being renewed must not read as absent, or the
       next writer takes a path somebody is holding. */
    await writeJsonAtomic(this.pathFor(lease.id), lease);
  }

  /**
   * One writer at a time, across processes. `mkdir` is the atomic primitive every
   * platform agrees on; a lock left behind by a crash is reclaimed once it is older
   * than any honest critical section here, so a killed agent cannot wedge the machine.
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
    /* Five seconds of contention on a directory read is not contention, it is a bug —
       and proceeding without the mutex would be the corruption this exists to prevent. */
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
