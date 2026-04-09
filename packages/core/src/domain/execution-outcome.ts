import type { ExecutionStatus } from '../constants/execution.constants';

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
}
