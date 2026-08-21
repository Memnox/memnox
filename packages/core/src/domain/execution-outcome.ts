import type { ExecutionStatus } from '../constants/execution.constants';

/** The caller's own measurement — testimony with a number, never a runtime fact. */
export interface ExecutionMeasurement {
  name: string;
  value: number;
  /** Free-form ("s", "rows", "%"); shown beside the value, never converted. */
  unit?: string;
}

/** The caller's testimony after acting; recorded verbatim, not derived. */
export interface ExecutionOutcomeReport {
  /** `Decision.eventId` — the audited decision that authorized this execution. */
  decisionEventId: string;
  action: string;
  target?: string;
  environment?: string;
  sessionId?: string;
  status: ExecutionStatus;
  /** Description of the condition that failed, when one did. */
  failedCondition?: string;
  /** A compensating action ran to undo the change. */
  rolledBack: boolean;
  /** Set when the rollback itself failed — state is now unknown. */
  rollbackError?: string;
  /** Milliseconds spent inside the guarded action. */
  durationMs?: number;
  /** What the caller's own checks measured. Omitted when nothing was measured. */
  measurements?: ExecutionMeasurement[];
}
