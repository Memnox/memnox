import type { MemnoxEvent } from '../event/event';
import { breachIn, DEFAULT_THRESHOLDS, type BreakerThresholds } from './breaker';
import type { SessionPause } from './pause';
import { outcomesFrom } from './replay';

/**
 * A session's replayed history turned into the pause the
 * breaker would hold it with, one way for every seam.
 */

export interface BreakerPauseInput {
  sessionId: string;
  /** The session's rows in ledger order, so the last one names what was running. */
  events: readonly MemnoxEvent[];
  pausedAt: string;
  thresholds?: BreakerThresholds;
}

/** The pause this history trips, or null when the breaker holds. */
export function breakerPauseFor(input: BreakerPauseInput): SessionPause | null {
  const { sessionId, events } = input;
  const breach = breachIn(outcomesFrom(events), input.thresholds ?? DEFAULT_THRESHOLDS);
  if (breach === null) return null;

  const last = events[events.length - 1];
  return {
    sessionId,
    signal: breach.signal,
    reason: breach.reason,
    reached: breach.reached,
    ceiling: breach.ceiling,
    pausedAt: input.pausedAt,
    ...(last === undefined ? {} : { lastAction: last.operation }),
  };
}
