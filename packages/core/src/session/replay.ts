import { DECISION_EFFECT } from '../constants/decision.constants';
import type { MemnoxEvent } from '../event/event';
import type { ActionOutcome } from './breaker';

/**
 * A session's history, as outcomes the breaker can read.
 *
 * The breaker was reachable only through the daemon, and no seam has ever spoken to
 * the daemon on the hot path — so on an ordinary machine it observed nothing, and the
 * loop it exists to stop ran until somebody noticed. Every seam already writes its
 * outcome to the ledger, so the ledger is the session, and replaying it needs no
 * second process to be running.
 *
 * Replayed rather than accumulated in memory because each interceptor invocation is
 * its own process: there is no long-lived thing on an ordinary machine to hold a
 * counter, and inventing one would make the feature depend on a daemon again.
 */
export function outcomesFrom(events: readonly MemnoxEvent[]): ActionOutcome[] {
  return events
    .filter((event) => event.effect === DECISION_EFFECT.ALLOW)
    .map((event) => ({
      sessionId: event.sessionId,
      /* Action and target together: `npm test` twice is the same work, and `rm a`
         then `rm b` is not. The digest the row already carries is of the arguments,
         which are too specific — a retry regenerates them with a new nonce. */
      fingerprint: `${event.operation} ${event.target ?? ''}`,
      action: event.operation,
      at: event.at,
      failed: event.exitCode !== undefined && event.exitCode !== 0,
      ...(event.exitCode === undefined || event.exitCode === 0
        ? {}
        : { failureKind: `${event.operation}:${event.exitCode}` }),
      ...(event.costUsd === undefined ? {} : { costUsd: event.costUsd }),
    }))
    .sort((a, b) => a.at.localeCompare(b.at));
}

/**
 * How much history a seam replays before acting.
 *
 * Every trip condition is a sliding window, so the whole session is never needed. It
 * is bounded because this runs in front of every command: a session that has been
 * going all day must not make the next command pay for the whole day.
 */
export const REPLAY_LIMIT = 200;
