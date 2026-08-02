import type {
  Decision,
  ExecutionMeasurement,
  ExecutionOutcomeReport,
  ExecutionStatus,
} from '@memnox/core';
import { EXECUTION_STATUS } from '@memnox/core';

/**
 * What a check found. Returning a bare boolean stays supported — a condition
 * only reports a measurement when it has a number worth putting on the record.
 */
export interface ConditionResult {
  held: boolean;
  /** Recorded whether the condition held or not: a failure's number is the useful one. */
  measurement?: ExecutionMeasurement;
}

/** A named check the caller can run before or after the action. */
export interface Condition {
  description: string;
  check: () => Promise<boolean | ConditionResult>;
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
  /** Everything the conditions measured, in the order they ran. */
  measurements?: ExecutionMeasurement[];
}

const message = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** A bare boolean is a check that reported no number. */
function asResult(value: boolean | ConditionResult): ConditionResult {
  return typeof value === 'boolean' ? { held: value } : value;
}

/**
 * A condition that throws is a condition that did not hold. Measurements are
 * collected as they are taken, so a run that stops at the first failure still
 * reports what the checks before it saw.
 */
async function firstFailing(
  conditions: readonly Condition[],
  measured: ExecutionMeasurement[],
): Promise<string | null> {
  for (const condition of conditions) {
    const result = asResult(await condition.check().catch(() => false));
    if (result.measurement !== undefined) measured.push(result.measurement);
    if (!result.held) return condition.description;
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
  const measured: ExecutionMeasurement[] = [];
  const taken = (): { measurements?: ExecutionMeasurement[] } =>
    measured.length > 0 ? { measurements: measured } : {};

  const failedPrecondition = await firstFailing(plan.preconditions ?? [], measured);
  if (failedPrecondition) {
    return {
      status: EXECUTION_STATUS.PRECONDITION_FAILED,
      failedCondition: failedPrecondition,
      rolledBack: false,
      durationMs: elapsed(),
      ...taken(),
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
      ...taken(),
      ...repair,
    };
  }

  const failedPostcondition = await firstFailing(plan.postconditions ?? [], measured);
  if (failedPostcondition) {
    const repair = await attemptRollback(plan.rollback);
    return {
      status: EXECUTION_STATUS.POSTCONDITION_FAILED,
      failedCondition: failedPostcondition,
      durationMs: elapsed(),
      ...taken(),
      ...repair,
    };
  }

  return {
    status: EXECUTION_STATUS.SUCCEEDED,
    result,
    rolledBack: false,
    durationMs: elapsed(),
    ...taken(),
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
    ...(outcome.measurements && outcome.measurements.length > 0
      ? { measurements: outcome.measurements }
      : {}),
  };
}
