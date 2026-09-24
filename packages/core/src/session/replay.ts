import { DECISION_EFFECT } from '../constants/decision.constants';
import type { MemnoxEvent } from '../event/event';
import { didFail, workKey } from '../event/outcome';
import type { ActionOutcome } from './breaker';

/**
 * A session's history as outcomes the breaker can read, replayed from the ledger
 * because each interceptor is its own process and a counter would need a daemon.
 */
export function outcomesFrom(events: readonly MemnoxEvent[]): ActionOutcome[] {
  return events
    .filter((event) => event.effect === DECISION_EFFECT.ALLOW)
    .map((event) => ({
      sessionId: event.sessionId,
      // Operation and target rather than the argument digest, which a retry regenerates.
      fingerprint: workKey(event),
      action: event.operation,
      at: event.at,
      failed: didFail(event),
      ...(event.exitCode === undefined || event.exitCode === 0
        ? {}
        : { failureKind: `${event.operation}:${event.exitCode}` }),
      ...(event.costUsd === undefined ? {} : { costUsd: event.costUsd }),
    }))
    .sort((a, b) => a.at.localeCompare(b.at));
}

/** How much history a seam replays, since this runs in front of every command. */
export const REPLAY_LIMIT = 200;
