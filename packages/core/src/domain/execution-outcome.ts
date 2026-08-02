import type { ExecutionStatus } from '../constants/execution.constants';

/**
 * Something the caller measured while verifying its own action — rows written,
 * seconds of downtime, requests dropped. The runtime cannot observe any of it,
 * so a measurement is testimony with a number attached, never a fact the
 * runtime checked. Naming and units are the caller's; nothing here is derived.
 */
export interface ExecutionMeasurement {
  name: string;
  value: number;
  /** Free-form ("s", "rows", "%"); shown beside the value, never converted. */
  unit?: string;
}

/**
 * Reported by a caller after acting on an allowed decision. The runtime records
 * it verbatim — it is a caller's testimony about its own execution, not a
 * verdict the runtime derived.
 */
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
