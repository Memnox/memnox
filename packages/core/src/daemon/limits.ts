/**
 * A session that has been running for six hours, or has called the same tool four
 * hundred times, is not doing what somebody asked. Limits are counted per session and
 * stated in the config, so a runaway ends without anybody having to be watching.
 */

export const LIMIT = {
  RUNTIME: 'runtime',
  TOOL_CALLS: 'tool-calls',
  /** The same action on the same target, over and over: a loop, not work. */
  REPEATED_ACTION: 'repeated-action',
} as const;

export type LimitKind = (typeof LIMIT)[keyof typeof LIMIT];

export interface Limits {
  /** Minutes a session may run. Zero means no limit. */
  runtimeMinutes: number;
  toolCalls: number;
  repeatedAction: number;
}

export const DEFAULT_LIMITS: Limits = {
  runtimeMinutes: 240,
  toolCalls: 1000,
  repeatedAction: 25,
};

export interface LimitBreach {
  kind: LimitKind;
  /** What the count reached, and what the ceiling was. */
  reached: number;
  ceiling: number;
  reason: string;
}

export interface SessionCounts {
  sessionId: string;
  startedAt: string;
  toolCalls: number;
  /** action+target digest → how many times. A loop shows up here first. */
  repeats: Map<string, number>;
}

/**
 * Counting only. What to do about a breach is the caller's, because stopping an agent
 * mid-task is a decision somebody has to have configured rather than one a counter
 * takes on its own.
 */
export class SessionLimits {
  private readonly sessions = new Map<string, SessionCounts>();

  constructor(private readonly limits: Limits = DEFAULT_LIMITS) {}

  start(sessionId: string, startedAt: string): void {
    if (this.sessions.has(sessionId)) return;
    this.sessions.set(sessionId, {
      sessionId,
      startedAt,
      toolCalls: 0,
      repeats: new Map(),
    });
  }

  end(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  counts(sessionId: string): SessionCounts | null {
    return this.sessions.get(sessionId) ?? null;
  }

  /** Null when nothing was breached. The moment is passed in, never read from a clock. */
  record(sessionId: string, fingerprint: string, now: string): LimitBreach | null {
    const session = this.sessions.get(sessionId);
    if (session === undefined) {
      this.start(sessionId, now);
      return this.record(sessionId, fingerprint, now);
    }

    session.toolCalls += 1;
    const repeats = (session.repeats.get(fingerprint) ?? 0) + 1;
    session.repeats.set(fingerprint, repeats);

    if (this.limits.toolCalls > 0 && session.toolCalls > this.limits.toolCalls) {
      return {
        kind: LIMIT.TOOL_CALLS,
        reached: session.toolCalls,
        ceiling: this.limits.toolCalls,
        reason: `this session has made ${session.toolCalls} tool calls, past the ${this.limits.toolCalls} you allow`,
      };
    }
    if (this.limits.repeatedAction > 0 && repeats > this.limits.repeatedAction) {
      return {
        kind: LIMIT.REPEATED_ACTION,
        reached: repeats,
        ceiling: this.limits.repeatedAction,
        reason: `the same action has run ${repeats} times, which is a loop rather than work`,
      };
    }

    const minutes = (Date.parse(now) - Date.parse(session.startedAt)) / 60_000;
    if (this.limits.runtimeMinutes > 0 && minutes > this.limits.runtimeMinutes) {
      return {
        kind: LIMIT.RUNTIME,
        reached: Math.floor(minutes),
        ceiling: this.limits.runtimeMinutes,
        reason: `this session has been running ${Math.floor(minutes)} minutes, past the ${this.limits.runtimeMinutes} you allow`,
      };
    }
    return null;
  }
}

/**
 * The same refusal, again and again. Somebody being told no three times is not being
 * stubborn; it is a rule that does not match how the work actually gets done, and the
 * third attempt is when that becomes worth saying.
 */
export const REPEATED_VIOLATION_THRESHOLD = 3;

export interface Violation {
  action: string;
  target?: string;
  at: string;
}

export class ViolationMemory {
  private readonly seen = new Map<string, Violation[]>();

  record(violation: Violation): number {
    const key = `${violation.action}:${violation.target ?? ''}`;
    const previous = this.seen.get(key) ?? [];
    previous.push(violation);
    this.seen.set(key, previous);
    return previous.length;
  }

  /** Every previous attempt at this exact thing, so `why` can name them. */
  history(action: string, target?: string): readonly Violation[] {
    return this.seen.get(`${action}:${target ?? ''}`) ?? [];
  }

  isRepeated(action: string, target?: string): boolean {
    return this.history(action, target).length >= REPEATED_VIOLATION_THRESHOLD;
  }
}
