import {
  breakerPauseFor,
  describePause,
  exhaustedBy,
  readBudgets,
  REPLAY_LIMIT,
  SessionPauses,
  SqliteEventStore,
  type BreakerThresholds,
  type MemnoxEvent,
  type SessionPause,
} from '@memnox/core';

/**
 * What holds a tool call back before the rules are asked: the gate answers whether this
 * may happen, and a pause and a budget answer whether it may happen now.
 */

/** A day of calls, not a session's: a daily budget is counted across sessions. */
const SPEND_REPLAY_LIMIT = 20_000;

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
 * The real thing, over `~/.memnox`. Every method
 * answers "nothing holding you" when it cannot read.
 */
export function sessionLimitsFor(options: SessionLimitsOptions): SessionLimits {
  return new HomeSessionLimits(options);
}

class HomeSessionLimits implements SessionLimits {
  private readonly now: () => Date;

  constructor(private readonly options: SessionLimitsOptions) {
    this.now = options.now ?? ((): Date => new Date());
  }

  async heldBy(sessionId: string): Promise<SessionPause | null> {
    try {
      return await new SessionPauses(this.options.home).inForce(sessionId);
    } catch {
      // Unreadable is not paused: a broken pause file must not wedge every call.
      return null;
    }
  }

  async exhausted(action: string, sessionId: string | undefined): Promise<string | null> {
    try {
      const budgets = await readBudgets(this.options.home);
      // An empty book never refuses anything, and reading the ledger for it costs.
      if (budgets.length === 0) return null;
      const events = await this.events({ limit: SPEND_REPLAY_LIMIT });
      const breach = exhaustedBy(budgets, {
        action,
        events,
        now: this.now().toISOString(),
        sessionId,
      });
      return breach === null ? null : breach.reason;
    } catch {
      return null;
    }
  }

  async observe(sessionId: string): Promise<SessionPause | null> {
    try {
      const pause = breakerPauseFor({
        sessionId,
        events: await this.events({ sessionId, limit: REPLAY_LIMIT }),
        pausedAt: this.now().toISOString(),
        ...(this.options.thresholds === undefined
          ? {}
          : { thresholds: this.options.thresholds }),
      });
      if (pause === null) return null;
      await new SessionPauses(this.options.home).pause(pause);
      return pause;
    } catch {
      // No ledger, or it would not open. The call has already happened either way.
      return null;
    }
  }

  private async events(query: {
    sessionId?: string;
    limit: number;
  }): Promise<MemnoxEvent[]> {
    const store = SqliteEventStore.forHome(this.options.home);
    try {
      return await store.query(query);
    } finally {
      store.close();
    }
  }
}

/** What a held session is told, naming the command that lets it carry on. */
export function heldReason(pause: SessionPause): string {
  return `${describePause(pause)}, so resume with "memnox resume ${pause.sessionId}"`;
}
