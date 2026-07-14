import type { Decision, ExecutionOutcomeReport, ExecutionStatus } from '@memnox/core';
import { EXECUTION_STATUS } from '@memnox/core';

/** A named check the caller can run before or after the action. */
export interface Condition {
  description: string;
  check: () => Promise<boolean>;
}

/** The compensating action that undoes a change which failed verification. */
export interface Rollback {
  description: string;
  execute: () => Promise<void>;
}

export interface GuardedExecution<T> {
  /** Must all hold before the action runs; a failure means it never runs. */
  preconditions?: Condition[];
  /** Must all hold afterwards; a failure triggers the rollback. */
  postconditions?: Condition[];
  rollback?: Rollback;
  execute: () => Promise<T>;
}

export interface ExecutionOutcome<T> {
  status: ExecutionStatus;
  /** Present only when the action ran and every postcondition held. */
  result?: T;
  /** Description of the precondition or postcondition that failed. */
  failedCondition?: string;
  /** Message from the action itself when it threw. */
  error?: string;
  rolledBack: boolean;
  /** Set when the rollback also failed — state is unknown and needs a human. */
  rollbackError?: string;
  durationMs: number;
}

const message = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** A condition that throws is a condition that did not hold. */
async function firstFailing(conditions: readonly Condition[]): Promise<string | null> {
  for (const condition of conditions) {
    const held = await condition.check().catch(() => false);
    if (!held) return condition.description;
  }
  return null;
}

/**
 * Runs an action only if its preconditions hold, verifies its postconditions
 * afterwards, and undoes it when verification fails.
 *
 * The runtime decides whether an action *may* happen; this decides whether what
 * happened was correct, and repairs it when it was not. Pure orchestration — it
 * makes no network calls and never throws, so a caller always gets an outcome
 * it can report.
 */
export async function runGuarded<T>(
  plan: GuardedExecution<T>,
): Promise<ExecutionOutcome<T>> {
  const startedAt = Date.now();
  const elapsed = (): number => Date.now() - startedAt;

  const failedPrecondition = await firstFailing(plan.preconditions ?? []);
  if (failedPrecondition) {
    return {
      status: EXECUTION_STATUS.PRECONDITION_FAILED,
      failedCondition: failedPrecondition,
      rolledBack: false,
      durationMs: elapsed(),
    };
  }

  let result: T;
  try {
    result = await plan.execute();
  } catch (error) {
    const repair = await attemptRollback(plan.rollback);
    return {
      status: EXECUTION_STATUS.EXECUTION_FAILED,
      error: message(error),
      durationMs: elapsed(),
      ...repair,
    };
  }

  const failedPostcondition = await firstFailing(plan.postconditions ?? []);
  if (failedPostcondition) {
    const repair = await attemptRollback(plan.rollback);
    return {
      status: EXECUTION_STATUS.POSTCONDITION_FAILED,
      failedCondition: failedPostcondition,
      durationMs: elapsed(),
      ...repair,
    };
  }

  return {
    status: EXECUTION_STATUS.SUCCEEDED,
    result,
    rolledBack: false,
    durationMs: elapsed(),
  };
}

async function attemptRollback(
  rollback: Rollback | undefined,
): Promise<{ rolledBack: boolean; rollbackError?: string }> {
  if (!rollback) return { rolledBack: false };
  try {
    await rollback.execute();
    return { rolledBack: true };
  } catch (error) {
    return { rolledBack: false, rollbackError: message(error) };
  }
}

/** Shapes an outcome into the report the runtime audits. */
export function toOutcomeReport<T>(
  decision: Decision,
  request: { action: string; target?: string; environment?: string; sessionId?: string },
  outcome: ExecutionOutcome<T>,
): ExecutionOutcomeReport {
  return {
    decisionEventId: decision.eventId,
    action: request.action,
    ...(request.target ? { target: request.target } : {}),
    ...(request.environment ? { environment: request.environment } : {}),
    ...(request.sessionId ? { sessionId: request.sessionId } : {}),
    status: outcome.status,
    ...(outcome.failedCondition ? { failedCondition: outcome.failedCondition } : {}),
    rolledBack: outcome.rolledBack,
    ...(outcome.rollbackError ? { rollbackError: outcome.rollbackError } : {}),
    durationMs: outcome.durationMs,
  };
}
