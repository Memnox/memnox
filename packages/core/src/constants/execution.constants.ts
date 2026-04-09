/**
 * What became of an action after the runtime allowed it. A decision proves an
 * action was permitted; an outcome proves what it actually did.
 */
export const EXECUTION_STATUS = {
  /** Ran and every postcondition held. */
  SUCCEEDED: 'succeeded',
  /** A precondition failed — the action never ran. */
  PRECONDITION_FAILED: 'precondition_failed',
  /** The action itself threw. */
  EXECUTION_FAILED: 'execution_failed',
  /** The action ran but a postcondition did not hold afterwards. */
  POSTCONDITION_FAILED: 'postcondition_failed',
} as const;

export type ExecutionStatus = (typeof EXECUTION_STATUS)[keyof typeof EXECUTION_STATUS];

/** Statuses that mean state may have changed without being verified. */
export const UNVERIFIED_EXECUTION_STATUSES: readonly ExecutionStatus[] = [
  EXECUTION_STATUS.EXECUTION_FAILED,
  EXECUTION_STATUS.POSTCONDITION_FAILED,
];

/** Audited action name for a reported execution outcome. */
export const EXECUTION_OUTCOME_ACTION = 'execution.outcome';
