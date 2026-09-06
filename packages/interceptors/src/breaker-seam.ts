import {
  breachIn,
  DEFAULT_THRESHOLDS,
  describePause,
  outcomesFrom,
  REPLAY_LIMIT,
  SessionPauses,
  SqliteEventStore,
  type BreakerThresholds,
  type SessionPause,
} from '@memnox/core';

/**
 * The circuit breaker, in the seam rather than in a daemon.
 *
 * It lived only in the daemon, and no seam has ever spoken to the daemon on the hot
 * path — so on an ordinary machine the breaker observed nothing and the loop it exists
 * to stop ran until a person noticed the bill. Every seam already writes its outcome to
 * the ledger, so this replays the session from there. No second process to install, no
 * counter to keep, and it works in the default path rather than the optional one.
 *
 * Both halves are best effort. A ledger that will not open loses the breaker, never the
 * command: a tool that stops somebody working because it could not read its own history
 * is one they uninstall, and an uninstalled breaker stops nothing at all.
 */
export interface BreakerSeamOptions {
  home: string;
  sessionId: string | undefined;
  thresholds?: BreakerThresholds;
}

/** The pause holding this session, or null. Read before anything is allowed to run. */
export async function pauseHolding(
  home: string,
  sessionId: string | undefined,
): Promise<SessionPause | null> {
  if (sessionId === undefined || sessionId === '') return null;
  try {
    return await new SessionPauses(home).inForce(sessionId);
  } catch {
    // Unreadable is not paused: a broken pause file must not wedge every command.
    return null;
  }
}

/** What a held session prints instead of running. Named so `resume` is discoverable. */
export function pauseMessage(pause: SessionPause): string {
  return [
    `Paused by Memnox: ${describePause(pause)}`,
    `Resume with "memnox resume ${pause.sessionId}".`,
  ].join('\n');
}

/**
 * When a person last let this session carry on, so the replay starts after it.
 *
 * Null when it has never been paused, which is every ordinary session.
 */
async function resumedAt(home: string, sessionId: string): Promise<string | null> {
  try {
    const pause = await new SessionPauses(home).read(sessionId);
    return pause?.resumedAt ?? null;
  } catch {
    return null;
  }
}

/**
 * Replay what this session has done and hold it if the breaker trips.
 *
 * Called after the action, because the trip conditions need the outcome: "ran the same
 * command eleven times" is only knowable once the eleventh has finished.
 */
export async function observeSession(
  options: BreakerSeamOptions,
): Promise<SessionPause | null> {
  const { home, sessionId } = options;
  if (sessionId === undefined || sessionId === '') return null;

  try {
    /* Only what happened since a person last lifted a hold on this session.
       Replaying the whole ledger meant the failures that caused the pause were still
       in it, so the first command after `memnox resume` re-tripped the breaker on the
       same five failures — and the session could never actually be resumed. Lifting a
       hold is somebody saying "carry on from here", and this is what makes that true. */
    const since = await resumedAt(home, sessionId);

    const store = SqliteEventStore.forHome(home);
    let events;
    try {
      events = await store.query({
        sessionId,
        limit: REPLAY_LIMIT,
        ...(since === null ? {} : { since }),
      });
    } finally {
      store.close();
    }

    const breach = breachIn(
      outcomesFrom(events),
      options.thresholds ?? DEFAULT_THRESHOLDS,
    );
    if (breach === null) return null;

    const last = events[events.length - 1];
    const pause: SessionPause = {
      sessionId,
      signal: breach.signal,
      reason: breach.reason,
      reached: breach.reached,
      ceiling: breach.ceiling,
      pausedAt: new Date().toISOString(),
      ...(last === undefined ? {} : { lastAction: last.operation }),
    };
    await new SessionPauses(home).pause(pause);
    return pause;
  } catch {
    // No ledger, or it would not open. The command has already run either way.
    return null;
  }
}
