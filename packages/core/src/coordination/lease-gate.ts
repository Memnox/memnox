import {
  LEASE_MAX_WAIT_MS,
  describeLease,
  waitFor,
  type Lease,
  type LeaseHolder,
  type LeaseRequest,
} from './lease';
import { LEASE_OUTCOME, type LeaseRegistry } from './lease-store';
import { shortMachine } from './shared-actions';
import { SHARED_OUTCOME, type SharedLeases, type SharedTake } from './shared-leases';
import type { WrittenRegion } from './written-region';
import { minutesToMs, msToWholeMinutes } from '../domain/time';

/**
 * What happens when somebody else already holds the path a write needs. Every wait is
 * bounded, every refusal names the holder, and taking it anyway is a row.
 */

export const LEASE_ANSWER = {
  /** Wait for the holder, bounded. */
  WAIT: 'wait',
  /** Take it anyway, with a reason. Recorded, never silent. */
  TAKE: 'take',
  REFUSE: 'refuse',
} as const;

export type LeaseAnswer = (typeof LEASE_ANSWER)[keyof typeof LEASE_ANSWER];

export interface LeaseAsked {
  answer: LeaseAnswer;
  /** Required for `TAKE`: an override with no reason is a slower allow. */
  reason?: string;
}

/** Where the question is asked. Injected, so nothing here needs a terminal. */
export interface LeasePrompt {
  /** Null when there is nobody to ask, meaning no TTY or an unattended run. */
  ask(
    held: Lease,
    wanted: string,
    moment: string,
    waitMs: number,
  ): Promise<LeaseAsked | null>;
}

export const LEASE_GATE = {
  /** Nobody was in the way, or the holder was this same session. */
  TAKEN: 'taken',
  /** Somebody was, and they let go inside the window. */
  WAITED: 'waited',
  /** Somebody was, and it was taken from them on the record. */
  TOOK_OVER: 'took-over',
  /** Somebody was, and the writer stood down. */
  REFUSED: 'refused',
  /** Somebody was, nobody could be asked, and the wait ran out. Names the holder. */
  TIMED_OUT: 'timed-out',
} as const;

export type LeaseGateOutcome = (typeof LEASE_GATE)[keyof typeof LEASE_GATE];

export interface LeaseVerdict {
  outcome: LeaseGateOutcome;
  lease?: Lease;
  /** The lease that was in the way, so a refusal can name who to go and ask. */
  holding?: Lease;
  /** What to print. A refusal that explains nothing gets the wrapper removed. */
  message?: string;
  /** The workspace lease in the way, so the person at the refused agent can take it over. */
  sharedLeaseId?: string;
  /** The refusal without the command to type, for a host that asks its person itself. */
  asked?: string;
}

export function proceeds(verdict: LeaseVerdict): boolean {
  return (
    verdict.outcome === LEASE_GATE.TAKEN ||
    verdict.outcome === LEASE_GATE.WAITED ||
    verdict.outcome === LEASE_GATE.TOOK_OVER
  );
}

export interface LeaseGateDeps {
  registry: LeaseRegistry;
  /** The workspace register, consulted after the local one, which is cheaper and more often right. */
  shared?: SharedLeases;
  prompt?: LeasePrompt;
  /** What in the file this write touches, absent for the whole file. Asked only after the local register agrees. */
  region?: (path: string) => Promise<WrittenRegion>;
  /** The clock, injected so a replay gives the same answer twice. */
  now: () => string;
  sleep?: (ms: number) => Promise<void>;
  /** How long a wait may run at most, whatever the lease says. */
  ceilingMs?: number;
  pollMs?: number;
}

const DEFAULT_POLL_MS = 500;
/** Matches the local default, so one window is not quietly longer than the other. */
const DEFAULT_SHARED_MINUTES = 30;

type HeldElsewhere = Extract<
  SharedTake,
  { outcome: typeof SHARED_OUTCOME.HELD_BY_ANOTHER }
>;

/** Names the lines and function where git could tell, so the agent works on the rest. */
function heldElsewhere(result: HeldElsewhere, now: string): string {
  const where = result.machine === undefined ? '' : ` on ${shortMachine(result.machine)}`;
  const path = result.path === '' ? 'this repository' : result.path;
  const part = describeRegion(result.region);
  const held =
    part === null
      ? `${result.holder}${where} is writing ${path}.`
      : `${result.holder}${where} is editing ${part} of ${path}. The rest of the file is free.`;
  // Named for a person, since the command asks on a terminal and the agent cannot run it on itself.
  const free =
    result.leaseId === undefined
      ? ''
      : ` A person can free them now by running \`memnox lock --free ${result.leaseId}\`.`;
  return `${held}${quiet(result, now)}${free}`;
}

/** The same answer with no lease to name, so no command to free it is offered. */
function withoutLease(result: HeldElsewhere): HeldElsewhere {
  const { leaseId: _named, ...rest } = result;
  return rest;
}

/** How long a holder has done nothing before a refusal says so. */
const QUIET_AFTER_MS = minutesToMs(2);

/** Says the holder has gone quiet and when its hold lapses, so the waiter comes back rather than gives up. */
function quiet(result: { lastActive?: string; until?: string }, now: string): string {
  if (result.lastActive === undefined) return '';
  const idle = Date.parse(now) - Date.parse(result.lastActive);
  if (!Number.isFinite(idle) || idle < QUIET_AFTER_MS) return '';
  const minutes = msToWholeMinutes(idle);
  const lapse =
    result.until === undefined ? '' : `, so they free up at ${clock(result.until)}`;
  return ` It has been quiet for ${minutes} minutes${lapse} unless it comes back.`;
}

/** `14:40 UTC`, which is what a person and a model both read at a glance. */
function clock(iso: string): string {
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? iso : `${at.toISOString().slice(11, 16)} UTC`;
}

/** `retryCharge (lines 7 to 12)`, or null where nothing narrower than the file is known. */
function describeRegion(region: WrittenRegion | undefined): string | null {
  if (region === undefined) return null;
  const spans = region.lines.map((each) =>
    each.from === each.to ? `line ${each.from}` : `lines ${each.from} to ${each.to}`,
  );
  const names = region.symbols;
  if (names.length === 0 && spans.length === 0) return null;
  if (names.length === 0) return spans.join(', ');
  const named = names.join(', ');
  return spans.length === 0 ? named : `${named} (${spans.join(', ')})`;
}

/** A claim in flight: what the writer asked for, and the lease in its way. */
interface HeldClaim {
  request: LeaseRequest;
  holding: Lease;
}

export class LeaseGate {
  constructor(private readonly deps: LeaseGateDeps) {}

  /**
   * Takes the path, or answers with what to do about the agent already on it. Reads never
   * reach here, because `takesLease` decides before this is called.
   */
  async claim(
    path: string,
    holder: LeaseHolder,
    activity: string,
    minutes?: number,
  ): Promise<LeaseVerdict> {
    const request: LeaseRequest = { path, holder, activity, minutes };
    const first = await this.deps.registry.take(request, this.deps.now());
    if (first.outcome === LEASE_OUTCOME.TAKEN)
      return this.confirmShared(request, first.lease);
    // A path this cannot reason about gets no invented lease, and refusing would block work over a spelling.
    if (first.outcome === LEASE_OUTCOME.UNUSABLE_PATH)
      return { outcome: LEASE_GATE.TAKEN };

    const held: HeldClaim = { request, holding: first.holding };
    const ceiling = this.deps.ceilingMs ?? LEASE_MAX_WAIT_MS;
    const budget = waitFor(held.holding, this.deps.now(), ceiling);
    const asked = await this.ask(held.holding, path, budget);
    if (asked === null || asked.answer === LEASE_ANSWER.WAIT)
      return this.waitOut(held, budget);
    if (asked.answer === LEASE_ANSWER.TAKE)
      return this.takeOver(held, asked.reason ?? '');
    return {
      outcome: LEASE_GATE.REFUSED,
      holding: held.holding,
      message: `Stood down: ${describeLease(held.holding, this.deps.now())}`,
    };
  }

  // Another machine holding it means the local lease goes straight back, or the register goes stale.
  private async confirmShared(
    request: LeaseRequest,
    lease: Lease,
  ): Promise<LeaseVerdict> {
    const elsewhere = await this.claimShared(request);
    if (elsewhere === null) return { outcome: LEASE_GATE.TAKEN, lease };
    await this.deps.registry.release(lease.id, request.holder, this.deps.now());
    return elsewhere;
  }

  /**
   * Null when the workspace knows of no holder, which includes not knowing at all: a
   * lease is coordination and not safety, so a network hiccup must not block work.
   */
  private async claimShared(request: LeaseRequest): Promise<LeaseVerdict | null> {
    const shared = this.deps.shared;
    if (shared === undefined) return null;
    const region = await this.regionOf(request.path);
    const result = await shared.take(
      request.path,
      request.holder,
      request.minutes ?? DEFAULT_SHARED_MINUTES,
      region,
    );
    if (result.outcome !== SHARED_OUTCOME.HELD_BY_ANOTHER) return null;
    return {
      outcome: LEASE_GATE.REFUSED,
      message: heldElsewhere(result, this.deps.now()),
      asked: heldElsewhere(withoutLease(result), this.deps.now()),
      ...(result.leaseId === undefined ? {} : { sharedLeaseId: result.leaseId }),
    };
  }

  /** Never throws and never blocks the write: unknown is the whole file. */
  private async regionOf(path: string): Promise<WrittenRegion | undefined> {
    const read = this.deps.region;
    if (read === undefined) return undefined;
    try {
      return await read(path);
    } catch {
      return undefined;
    }
  }

  private async ask(
    holding: Lease,
    path: string,
    budget: number,
  ): Promise<LeaseAsked | null> {
    if (this.deps.prompt === undefined) return null;
    try {
      return await this.deps.prompt.ask(holding, path, this.deps.now(), budget);
    } catch {
      // A prompt that threw is a prompt nobody saw; wait it out rather than guessing.
      return null;
    }
  }

  /**
   * Bounded by the deadline and by a count, so a clock that does not advance cannot
   * turn the wait into a hang, which would be worse than the collision.
   */
  private async waitOut(held: HeldClaim, budget: number): Promise<LeaseVerdict> {
    const sleep =
      this.deps.sleep ??
      ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
    const poll = this.deps.pollMs ?? DEFAULT_POLL_MS;
    const deadline = Date.parse(this.deps.now()) + budget;
    const attempts = Math.max(1, Math.ceil(budget / poll));

    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (Date.parse(this.deps.now()) >= deadline) break;
      await sleep(poll);
      const retry = await this.deps.registry.take(held.request, this.deps.now());
      if (retry.outcome === LEASE_OUTCOME.TAKEN) {
        return { outcome: LEASE_GATE.WAITED, lease: retry.lease };
      }
    }

    return {
      outcome: LEASE_GATE.TIMED_OUT,
      holding: held.holding,
      message: `${describeLease(held.holding, this.deps.now())} and did not let go. Wait, or take it with "memnox lock ${held.request.path}".`,
    };
  }

  private async takeOver(held: HeldClaim, reason: string): Promise<LeaseVerdict> {
    const { request, holding } = held;
    if (reason.trim() === '') {
      // An override nobody can explain is not an override.
      return {
        outcome: LEASE_GATE.REFUSED,
        holding,
        message: 'Taking a held path needs a reason, so the record says why.',
      };
    }
    await this.deps.registry.takeOver(
      holding.id,
      request.holder,
      reason,
      this.deps.now(),
    );
    const mine = await this.deps.registry.take(request, this.deps.now());
    return {
      outcome: LEASE_GATE.TOOK_OVER,
      holding,
      ...(mine.outcome === LEASE_OUTCOME.TAKEN ? { lease: mine.lease } : {}),
      message: `Took ${holding.path} from ${holding.holder.agent}: ${reason}`,
    };
  }
}
