import {
  breachIn,
  DEFAULT_THRESHOLDS,
  describePause,
  exhaustedBy,
  outcomesFrom,
  readBudgets,
  REPLAY_LIMIT,
  SessionPauses,
  SqliteEventStore,
  type Budget,
  type BreakerThresholds,
  type MemnoxEvent,
  type SessionPause,
} from '@memnox/core';

/**
 * What holds a tool call back before the rules are even asked.
 *
 * The gate answers "may this happen". These two answer "may this happen *now*",
 * and they were reaching only half the estate: `pauseHolding` was called from the
 * shell interceptor and `exhaustedBy` from the daemon, so a session the breaker had
 * paused went on making MCP calls and an exhausted budget stopped nothing an agent
 * did through a tool. An agent that works entirely through MCP servers — which is
 * most of them — met neither.
 *
 * The rules themselves stay in `@memnox/core`; this is the adapter that reads them
 * on this transport, the same shape `ledger.ts` and `local-gate-loader.ts` already
 * have. The interceptors have their own adapter over the same core functions,
 * because the two transports learn a session id and an outcome by different means
 * and a shared wrapper would have to be told which one it was serving.
 */

/** Read where a disk read is safe, so the proxy's hot path never touches one. */
export interface SessionLimits {
  /** The pause holding this session, or null. */
  heldBy(sessionId: string): Promise<SessionPause | null>;
  /** The budget this action would take past its limit, or null. */
  exhausted(action: string, sessionId: string | undefined): Promise<string | null>;
  /** Replay the session and hold it if the breaker has tripped. */
  observe(sessionId: string): Promise<SessionPause | null>;
}

export interface SessionLimitsOptions {
  home: string;
  thresholds?: BreakerThresholds;
  now?: () => Date;
}

/**
 * The real thing, over `~/.memnox`.
 *
 * Every method is best effort and answers "nothing is holding you" when it cannot
 * read. That is the same bargain the ledger makes and for the same reason: a proxy
 * that wedges an agent because it could not open its own history is one nobody
 * leaves installed, and an uninstalled proxy enforces nothing at all.
 */
export function sessionLimitsFor(options: SessionLimitsOptions): SessionLimits {
  const { home } = options;
  const now = options.now ?? ((): Date => new Date());

  const events = async (query: {
    sessionId?: string;
    limit: number;
  }): Promise<MemnoxEvent[]> => {
    const store = SqliteEventStore.forHome(home);
    try {
      return await store.query(query);
    } finally {
      store.close();
    }
  };

  return {
    heldBy: async (sessionId) => {
      try {
        return await new SessionPauses(home).inForce(sessionId);
      } catch {
        // Unreadable is not paused: a broken pause file must not wedge every call.
        return null;
      }
    },

    exhausted: async (action, sessionId) => {
      try {
        const budgets: Budget[] = await readBudgets(home);
        // An empty book never refuses anything, and reading the ledger for it costs.
        if (budgets.length === 0) return null;
        const spent = await events({ limit: SPEND_REPLAY_LIMIT });
        const breach = exhaustedBy(
          budgets,
          action,
          spent,
          now().toISOString(),
          sessionId,
        );
        return breach === null ? null : breach.reason;
      } catch {
        return null;
      }
    },

    observe: async (sessionId) => {
      try {
        const seen = await events({ sessionId, limit: REPLAY_LIMIT });
        const breach = breachIn(
          outcomesFrom(seen),
          options.thresholds ?? DEFAULT_THRESHOLDS,
        );
        if (breach === null) return null;

        const last = seen[seen.length - 1];
        const pause: SessionPause = {
          sessionId,
          signal: breach.signal,
          reason: breach.reason,
          reached: breach.reached,
          ceiling: breach.ceiling,
          pausedAt: now().toISOString(),
          ...(last === undefined ? {} : { lastAction: last.operation }),
        };
        await new SessionPauses(home).pause(pause);
        return pause;
      } catch {
        // No ledger, or it would not open. The call has already happened either way.
        return null;
      }
    },
  };
}

/** A day of calls, not a session's: a daily budget is counted across sessions. */
const SPEND_REPLAY_LIMIT = 20_000;

/** What a held session is told, naming the command that lets it carry on. */
export function heldReason(pause: SessionPause): string {
  return `${describePause(pause)} — resume with "memnox resume ${pause.sessionId}"`;
}
