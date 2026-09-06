/**
 * Stopping an agent that is not getting anywhere.
 *
 * `SessionLimits` already holds the flat ceilings — how long, how many calls, the same
 * action over and over. Those are answerable from the request alone. Everything here
 * needs the *outcome*, and that is the difference between "this session has run four
 * hundred commands" and "this session has run the same failing command eleven times
 * and nothing has moved".
 *
 * Two rules hold throughout. Every signal is counted from what actually happened, never
 * estimated: a breaker that pauses on a guess gets switched off the first week. And a
 * pause is not a denial — the work is held for a person, with the count that produced
 * it, because the honest answer to "why did you stop my agent" is a number.
 */

export const BREAKER_SIGNAL = {
  /** The same action failing the same way. A loop, not work. */
  ERROR_LOOP: 'error-loop',
  /** Failure after failure with nothing succeeding in between. */
  NO_PROGRESS: 'no-progress',
  /** Far past what the task said it would take. */
  ACTION_EXPLOSION: 'action-explosion',
  /** Working somewhere it was not asked to work. */
  SCOPE_DRIFT: 'scope-drift',
  /** Spending, with nothing to show. Counted only from a cost somebody reported. */
  SPEND: 'spend',
} as const;

export type BreakerSignal = (typeof BREAKER_SIGNAL)[keyof typeof BREAKER_SIGNAL];

export interface BreakerThresholds {
  /** Identical failures before the loop is called a loop. */
  errorLoop: number;
  /** Consecutive failures with nothing succeeding. */
  noProgress: number;
  /** Multiple of the task's own estimate. Never applies without a declared estimate. */
  explosionFactor: number;
  /** Actions outside the declared task. Never applies without a declared task. */
  scopeDrift: number;
  /** Dollars. Zero means nothing is watching spend, which is the default. */
  spendCeilingUsd: number;
}

export const DEFAULT_THRESHOLDS: BreakerThresholds = {
  errorLoop: 5,
  noProgress: 8,
  explosionFactor: 5,
  scopeDrift: 5,
  spendCeilingUsd: 0,
};

/** One thing that happened, as the seam already knows it after running the command. */
export interface ActionOutcome {
  sessionId: string;
  /** Action plus target, digested by the caller. Identical work shares one. */
  fingerprint: string;
  action: string;
  at: string;
  /** Whether it failed. The caller decides: an exit code means different things per tool. */
  failed: boolean;
  /** Distinguishes "failing the same way" from "failing differently every time". */
  failureKind?: string;
  outOfScope?: boolean;
  /** Reported, never estimated. Absent on every surface that cannot know it. */
  costUsd?: number;
}

export interface BreakerBreach {
  signal: BreakerSignal;
  reached: number;
  ceiling: number;
  /** In the words the pause will use. A number nobody can read is not evidence. */
  reason: string;
}

interface SessionState {
  actions: number;
  /** fingerprint+failureKind → how many times it has failed that exact way. */
  failures: Map<string, number>;
  consecutiveFailures: number;
  outOfScope: number;
  spentUsd: number;
  /** What the task said it would take, when a task declared one. */
  expectedActions?: number;
}

function emptyState(expectedActions?: number): SessionState {
  return {
    actions: 0,
    failures: new Map(),
    consecutiveFailures: 0,
    outOfScope: 0,
    spentUsd: 0,
    ...(expectedActions === undefined ? {} : { expectedActions }),
  };
}

/**
 * Counting only. What to do about a breach is the caller's: pausing an agent mid-task
 * is a decision somebody has to have configured, not one a counter takes on its own.
 */
export class CircuitBreaker {
  private readonly sessions = new Map<string, SessionState>();

  constructor(private readonly thresholds: BreakerThresholds = DEFAULT_THRESHOLDS) {}

  /** What the task declared, so explosion has something to be a multiple of. */
  expect(sessionId: string, expectedActions: number): void {
    const state = this.sessions.get(sessionId) ?? emptyState();
    state.expectedActions = expectedActions;
    this.sessions.set(sessionId, state);
  }

  forget(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  /** Null when nothing tripped. The first signal to trip wins; order is severity. */
  observe(outcome: ActionOutcome): BreakerBreach | null {
    const state = this.sessions.get(outcome.sessionId) ?? emptyState();
    this.sessions.set(outcome.sessionId, state);

    state.actions += 1;
    state.spentUsd += outcome.costUsd ?? 0;
    if (outcome.outOfScope === true) state.outOfScope += 1;

    if (outcome.failed) {
      state.consecutiveFailures += 1;
      const key = `${outcome.fingerprint}:${outcome.failureKind ?? ''}`;
      state.failures.set(key, (state.failures.get(key) ?? 0) + 1);
      const same = state.failures.get(key) ?? 0;
      if (same >= this.thresholds.errorLoop) {
        return {
          signal: BREAKER_SIGNAL.ERROR_LOOP,
          reached: same,
          ceiling: this.thresholds.errorLoop,
          reason: `${outcome.action} has failed the same way ${same} times; retrying it again will fail the same way`,
        };
      }
    } else {
      // Anything that worked is progress, and progress resets the run of failures.
      state.consecutiveFailures = 0;
    }

    if (state.consecutiveFailures >= this.thresholds.noProgress) {
      return {
        signal: BREAKER_SIGNAL.NO_PROGRESS,
        reached: state.consecutiveFailures,
        ceiling: this.thresholds.noProgress,
        reason: `${state.consecutiveFailures} actions in a row have failed and nothing has succeeded in between`,
      };
    }

    /* Only against an estimate somebody typed. Without one there is no such thing as
       too many actions, and inventing a number would pause honest long sessions. */
    const expected = state.expectedActions;
    if (expected !== undefined && expected > 0) {
      const ceiling = expected * this.thresholds.explosionFactor;
      if (state.actions > ceiling) {
        return {
          signal: BREAKER_SIGNAL.ACTION_EXPLOSION,
          reached: state.actions,
          ceiling,
          reason: `this was expected to take about ${expected} actions and has taken ${state.actions}`,
        };
      }
    }

    if (
      this.thresholds.scopeDrift > 0 &&
      state.outOfScope >= this.thresholds.scopeDrift
    ) {
      return {
        signal: BREAKER_SIGNAL.SCOPE_DRIFT,
        reached: state.outOfScope,
        ceiling: this.thresholds.scopeDrift,
        reason: `${state.outOfScope} actions have been outside what this session was asked to do`,
      };
    }

    if (
      this.thresholds.spendCeilingUsd > 0 &&
      state.spentUsd > this.thresholds.spendCeilingUsd
    ) {
      return {
        signal: BREAKER_SIGNAL.SPEND,
        reached: Math.round(state.spentUsd * 100) / 100,
        ceiling: this.thresholds.spendCeilingUsd,
        reason: `this session has spent $${state.spentUsd.toFixed(2)} of its $${this.thresholds.spendCeilingUsd.toFixed(2)}`,
      };
    }

    return null;
  }

  /** What has been counted so far, for a report that is not waiting for a breach. */
  counts(sessionId: string): {
    actions: number;
    consecutiveFailures: number;
    outOfScope: number;
    spentUsd: number;
  } | null {
    const state = this.sessions.get(sessionId);
    if (state === undefined) return null;
    return {
      actions: state.actions,
      consecutiveFailures: state.consecutiveFailures,
      outOfScope: state.outOfScope,
      spentUsd: state.spentUsd,
    };
  }
}

/**
 * The same verdict, reached from the ledger instead of from memory.
 *
 * Two callers, one rule. The daemon counts as it goes because it is on the hot path;
 * `memnox report` and anything reading history has to reach the same answer, and a
 * second implementation is how a screen comes to describe a breaker that never fires.
 */
export function breachIn(
  outcomes: readonly ActionOutcome[],
  thresholds: BreakerThresholds = DEFAULT_THRESHOLDS,
  expectedActions?: number,
): BreakerBreach | null {
  const breaker = new CircuitBreaker(thresholds);
  const [first] = outcomes;
  if (first !== undefined && expectedActions !== undefined) {
    breaker.expect(first.sessionId, expectedActions);
  }
  for (const outcome of outcomes) {
    const breach = breaker.observe(outcome);
    if (breach !== null) return breach;
  }
  return null;
}
