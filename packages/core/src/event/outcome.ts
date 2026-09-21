import { EXECUTION, type MemnoxEvent } from './event';

/**
 * What a recorded action came to, asked one way by every reader of the ledger, so a
 * report, the breaker and a claim check cannot disagree about whether it failed.
 */

/** Failed by its own report or by its exit code, whichever the seam could record. */
export function didFail(event: MemnoxEvent): boolean {
  return (
    event.execution === EXECUTION.FAILED ||
    (event.exitCode !== undefined && event.exitCode !== 0)
  );
}

/** The same operation on the same target is the same work, so a second run is a redo. */
export function workKey(event: MemnoxEvent): string {
  return `${event.operation}:${event.target ?? ''}`;
}
