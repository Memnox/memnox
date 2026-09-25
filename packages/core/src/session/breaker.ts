import { roundToCents } from './money';
/**
 * Stopping an agent that is not getting anywhere, from outcomes rather than requests:
 * the same failing command eleven times, not four hundred commands. Every signal is
 * counted from what happened, never estimated.
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

/** Counts one outcome in, and returns how many times it has now failed that exact way. */
function recordOutcome(state: SessionState, outcome: ActionOutcome): number {
  state.actions += 1;
  state.spentUsd += outcome.costUsd ?? 0;
  if (outcome.outOfScope === true) state.outOfScope += 1;
  if (!outcome.failed) {
    // Anything that worked is progress, and progress resets the run of failures.
    state.consecutiveFailures = 0;
    return 0;
  }
  state.consecutiveFailures += 1;
  const key = `${outcome.fingerprint}:${outcome.failureKind ?? ''}`;
  const same = (state.failures.get(key) ?? 0) + 1;
  state.failures.set(key, same);
  return same;
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

/** Counting only: pausing an agent mid-task is a decision somebody configured, not a counter's. */
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
    const sameFailures = recordOutcome(state, outcome);
    return (
      this.errorLoop(outcome, sameFailures) ??
      this.noProgress(state) ??
      this.actionExplosion(state) ??
      this.scopeDrift(state) ??
      this.spend(state)
    );
  }

  /**
   * One action outside the declared task, from a seam that reports nothing else, so the
   * action count, the failure run and the spend are left as they were.
   */
  observeDrift(sessionId: string): BreakerBreach | null {
    const state = this.sessions.get(sessionId) ?? emptyState();
    this.sessions.set(sessionId, state);
    state.outOfScope += 1;
    return this.scopeDrift(state);
  }

  private errorLoop(outcome: ActionOutcome, same: number): BreakerBreach | null {
    if (!outcome.failed || same < this.thresholds.errorLoop) return null;
    return {
      signal: BREAKER_SIGNAL.ERROR_LOOP,
      reached: same,
      ceiling: this.thresholds.errorLoop,
      reason: `${outcome.action} has failed the same way ${same} times; retrying it again will fail the same way`,
    };
  }

  private noProgress(state: SessionState): BreakerBreach | null {
    if (state.consecutiveFailures < this.thresholds.noProgress) return null;
    return {
      signal: BREAKER_SIGNAL.NO_PROGRESS,
      reached: state.consecutiveFailures,
      ceiling: this.thresholds.noProgress,
      reason: `${state.consecutiveFailures} actions in a row have failed and nothing has succeeded in between`,
    };
  }

  // Only against an estimate somebody typed, since inventing one would pause honest work.
  private actionExplosion(state: SessionState): BreakerBreach | null {
    const expected = state.expectedActions;
    if (expected === undefined || expected <= 0) return null;
    const ceiling = expected * this.thresholds.explosionFactor;
    if (state.actions <= ceiling) return null;
    return {
      signal: BREAKER_SIGNAL.ACTION_EXPLOSION,
      reached: state.actions,
      ceiling,
      reason: `this was expected to take about ${expected} actions and has taken ${state.actions}`,
    };
  }

  private scopeDrift(state: SessionState): BreakerBreach | null {
    const ceiling = this.thresholds.scopeDrift;
    if (ceiling <= 0 || state.outOfScope < ceiling) return null;
    return {
      signal: BREAKER_SIGNAL.SCOPE_DRIFT,
      reached: state.outOfScope,
      ceiling,
      reason: `${state.outOfScope} actions have been outside what this session was asked to do`,
    };
  }

  private spend(state: SessionState): BreakerBreach | null {
    const ceiling = this.thresholds.spendCeilingUsd;
    if (ceiling <= 0 || state.spentUsd <= ceiling) return null;
    return {
      signal: BREAKER_SIGNAL.SPEND,
      reached: roundToCents(state.spentUsd),
      ceiling,
      reason: `this session has spent $${state.spentUsd.toFixed(2)} of its $${ceiling.toFixed(2)}`,
    };
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

/** The same verdict reached from the ledger, through the same counter the daemon uses. */
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
