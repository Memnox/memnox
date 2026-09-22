import {
  LEASE_MAX_WAIT_MS,
  describeLease,
  waitFor,
  type Lease,
  type LeaseHolder,
} from './lease';
import { LEASE_OUTCOME, type LeaseRegistry } from './lease-store';
import { shortMachine } from './shared-actions';
import { SHARED_OUTCOME, type SharedLeases, type SharedTake } from './shared-leases';
import type { WrittenRegion } from './written-region';

/**
 * What happens when somebody else already holds the path a write needs.
 *
 * This is the one place in the runtime that makes an agent wait for a reason that is
 * not safety, so the rule it is built to is narrow: a wait is always bounded, a refusal
 * always names the holder, and taking it anyway is always a row somebody can find
 * later. An unbounded wait would be a hang dressed as coordination, and worse than the
 * collision it was meant to prevent.
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
  /** Null when there is nobody to ask — no TTY, or an unattended run. */
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
  /**
   * The workspace lease in the way, where another machine holds it, so the person
   * at the refused agent can take it over from where they are.
   */
  sharedLeaseId?: string;
  /**
   * The refusal without the command a person could type, for a host that asks its
   * person in its own prompt instead: telling them to go and type something while
   * asking them the same question is two ways to say one thing.
   */
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
  /**
   * The workspace's register, when this machine is enrolled. Consulted after the
   * local one, because a collision with a session on this machine is cheaper to
   * find and far more common — and because an unreachable control plane must never
   * be the reason an agent cannot write a file.
   */
  shared?: SharedLeases;
  prompt?: LeasePrompt;
  /**
   * What in the file this write touches, read at the moment of the write.
   *
   * Optional, and absent is the whole file. It exists so two agents in one file
   * are told apart without either being asked to declare anything: the change
   * itself already says which lines and, usually, which function.
   *
   * Consulted only once the local register has agreed, so a session that is
   * going to be refused by a collision on this machine never pays for it.
   */
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

/**
 * What an agent is told when another machine is writing the same part of a file.
 *
 * Which lines, and which function where git could tell, because "somebody holds
 * this file" sends the agent away from all of it, and the part that is actually
 * taken is usually a few lines of it. The other parts stay open, and saying so is
 * what lets the agent keep working instead of waiting.
 */
function heldElsewhere(
  result: Extract<SharedTake, { outcome: typeof SHARED_OUTCOME.HELD_BY_ANOTHER }>,
  now: string,
): string {
  const where = result.machine === undefined ? '' : ` on ${shortMachine(result.machine)}`;
  const path = result.path === '' ? 'this repository' : result.path;
  const part = describeRegion(result.region);
  const held =
    part === null
      ? `${result.holder}${where} is writing ${path}.`
      : `${result.holder}${where} is editing ${part} of ${path}. The rest of the file is free.`;
  /* The way out, named for a person: an agent told only "ask somebody" leaves
     the somebody with nothing to type. The command asks on a terminal, so the
     agent reading this cannot run it on itself. */
  const free =
    result.leaseId === undefined
      ? ''
      : ` A person can free them now by running \`memnox lock --free ${result.leaseId}\`.`;
  return `${held}${quiet(result, now)}${free}`;
}

/** The same answer with no lease to name, so no command to free it is offered. */
function withoutLease(
  result: Extract<SharedTake, { outcome: typeof SHARED_OUTCOME.HELD_BY_ANOTHER }>,
): Extract<SharedTake, { outcome: typeof SHARED_OUTCOME.HELD_BY_ANOTHER }> {
  const { leaseId: _named, ...rest } = result;
  return rest;
}

/** How long a holder has done nothing before a refusal says so. */
const QUIET_AFTER_MS = 2 * 60_000;

/**
 * Said when the holder has gone quiet, with when its hold lapses.
 *
 * A refusal naming an agent that stopped working ten minutes ago sends the waiting
 * agent away from lines nobody is writing. Saying it has gone quiet, and when the
 * lines free up on their own, lets it come back then rather than give up the work.
 */
function quiet(result: { lastActive?: string; until?: string }, now: string): string {
  if (result.lastActive === undefined) return '';
  const idle = Date.parse(now) - Date.parse(result.lastActive);
  if (!Number.isFinite(idle) || idle < QUIET_AFTER_MS) return '';
  const minutes = Math.floor(idle / 60_000);
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

export class LeaseGate {
  constructor(private readonly deps: LeaseGateDeps) {}

  /**
   * Takes the path, or answers with what to do about the agent already on it. Reads
   * never reach here: that decision is `takesLease`, made before this is called, so
   * there is no path through this class that can make a reader wait.
   */
  async claim(
    path: string,
    holder: LeaseHolder,
    activity: string,
    minutes?: number,
  ): Promise<LeaseVerdict> {
    const first = await this.deps.registry.take(
      path,
      holder,
      this.deps.now(),
      minutes,
      activity,
    );
    if (first.outcome === LEASE_OUTCOME.TAKEN) {
      const elsewhere = await this.claimShared(path, holder, minutes);
      if (elsewhere !== null) {
        /* Another machine holds it. The local lease is given straight back: holding
           a path this session may not write is how a stale register is built. */
        await this.deps.registry.release(first.lease.id, holder, this.deps.now());
        return elsewhere;
      }
      return { outcome: LEASE_GATE.TAKEN, lease: first.lease };
    }
    if (first.outcome === LEASE_OUTCOME.UNUSABLE_PATH) {
      /* A path this cannot reason about is one no lease should be invented for. It goes
         through: refusing here would block work over a spelling. */
      return { outcome: LEASE_GATE.TAKEN };
    }

    const holding = first.holding;
    const ceiling = this.deps.ceilingMs ?? LEASE_MAX_WAIT_MS;
    const budget = waitFor(holding, this.deps.now(), ceiling);

    const asked = await this.ask(holding, path, budget);
    if (asked === null || asked.answer === LEASE_ANSWER.WAIT) {
      return this.waitOut(path, holder, activity, holding, budget, minutes);
    }
    if (asked.answer === LEASE_ANSWER.TAKE) {
      return this.takeOver(holding, holder, asked.reason ?? '', path, activity, minutes);
    }
    return {
      outcome: LEASE_GATE.REFUSED,
      holding,
      message: `Stood down: ${describeLease(holding, this.deps.now())}`,
    };
  }

  /**
   * Null when the path is free as far as the workspace knows — which includes not
   * knowing at all. Unreachable is not held: a lease is coordination and not safety,
   * and one that blocked work whenever the network hiccuped would be turned off.
   */
  private async claimShared(
    path: string,
    holder: LeaseHolder,
    minutes?: number,
  ): Promise<LeaseVerdict | null> {
    const shared = this.deps.shared;
    if (shared === undefined) return null;

    /* Worked out here rather than by the caller, so every path into the gate
       gets it. A reader that throws or runs long is the whole file, which is
       what this claimed before it could narrow anything. */
    const region = await this.regionOf(path);

    const result = await shared.take(
      path,
      holder,
      minutes ?? DEFAULT_SHARED_MINUTES,
      region,
    );
    if (result.outcome !== SHARED_OUTCOME.HELD_BY_ANOTHER) return null;

    return {
      outcome: LEASE_GATE.REFUSED,
      message: heldElsewhere(result, this.deps.now()),
      asked: heldElsewhere({ ...withoutLease(result) }, this.deps.now()),
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

  /** Bounded by construction: the loop cannot outlive the budget it was given. */
  private async waitOut(
    path: string,
    holder: LeaseHolder,
    activity: string,
    holding: Lease,
    budget: number,
    minutes?: number,
  ): Promise<LeaseVerdict> {
    const sleep =
      this.deps.sleep ??
      ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
    const poll = this.deps.pollMs ?? DEFAULT_POLL_MS;
    const deadline = Date.parse(this.deps.now()) + budget;
    /* Bounded twice over. The deadline is the honest limit, and the count is what makes
       the bound structural: a clock that does not advance must not become a hang, which
       is the one failure here that would be worse than the collision it prevents. */
    const attempts = Math.max(1, Math.ceil(budget / poll));

    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (Date.parse(this.deps.now()) >= deadline) break;
      await sleep(poll);
      const retry = await this.deps.registry.take(
        path,
        holder,
        this.deps.now(),
        minutes,
        activity,
      );
      if (retry.outcome === LEASE_OUTCOME.TAKEN) {
        return { outcome: LEASE_GATE.WAITED, lease: retry.lease };
      }
    }

    return {
      outcome: LEASE_GATE.TIMED_OUT,
      holding,
      message: `${describeLease(holding, this.deps.now())} and did not let go. Wait, or take it with "memnox lock ${path}".`,
    };
  }

  private async takeOver(
    holding: Lease,
    holder: LeaseHolder,
    reason: string,
    path: string,
    activity: string,
    minutes?: number,
  ): Promise<LeaseVerdict> {
    if (reason.trim() === '') {
      // Rule 4 from the other end: an override nobody can explain is not an override.
      return {
        outcome: LEASE_GATE.REFUSED,
        holding,
        message: 'Taking a held path needs a reason, so the record says why.',
      };
    }
    await this.deps.registry.takeOver(holding.id, holder, reason, this.deps.now());
    const mine = await this.deps.registry.take(
      path,
      holder,
      this.deps.now(),
      minutes,
      activity,
    );
    return {
      outcome: LEASE_GATE.TOOK_OVER,
      holding,
      ...(mine.outcome === LEASE_OUTCOME.TAKEN ? { lease: mine.lease } : {}),
      message: `Took ${holding.path} from ${holding.holder.agent}: ${reason}`,
    };
  }
}
