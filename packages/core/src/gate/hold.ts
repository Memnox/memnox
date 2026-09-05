/**
 * Holding a call for a person. The agent is waiting on the other end of a pipe, so
 * every path here ends in a decision: answered, timed out, or refused because nobody
 * could be asked. A hold that could hang forever would be worse than a denial.
 */

export const HOLD_ANSWER = {
  /** This call only. The next identical one asks again. */
  ONCE: 'once',
  /** Every identical call for the rest of this session. */
  SESSION: 'session',
  DENY: 'deny',
  /**
   * The command was wrong, not the rule. The person fixes it and the agent's loop
   * survives — which is the difference between a gate people keep and one they remove.
   */
  EDIT: 'edit',
} as const;

export type HoldAnswer = (typeof HOLD_ANSWER)[keyof typeof HOLD_ANSWER];

export const HOLD_OUTCOME = {
  ALLOWED: 'allowed',
  DENIED: 'denied',
  /** The command was wrong. What replaces it is ruled on from the start, never trusted. */
  EDITED: 'edited',
  /** Nobody answered in time. Denied, and said differently so it reads differently. */
  TIMED_OUT: 'timed-out',
  /** No terminal to ask at. Denied, because a firewall fails closed. */
  UNATTENDED: 'unattended',
} as const;

export type HoldOutcome = (typeof HOLD_OUTCOME)[keyof typeof HOLD_OUTCOME];

/** Seconds. Long enough to read the prompt, short enough that a walk-away ends. */
export const DEFAULT_HOLD_TIMEOUT_MS = 120_000;

export interface HoldRequest {
  sessionId: string;
  agent: string;
  operation: string;
  target?: string;
  /** Identical calls share this, which is what "for this session" grants against. */
  fingerprint: string;
  reason: string;
  /** What produced the verdict, rendered by the caller. Shown, never summarised. */
  evidence?: readonly string[];
  /** The command as typed, when there is one. `[e]` edits this and nothing else. */
  command?: string;
}

export interface HoldAsked {
  answer: HoldAnswer;
  /** What the person typed instead, for HOLD_ANSWER.EDIT. */
  command?: string;
}

/** Where the question is actually asked. Injected, so tests need no terminal. */
export interface HoldPrompt {
  /** Null when there is nobody to ask — no TTY, or a non-interactive run. */
  ask(request: HoldRequest, timeoutMs: number): Promise<HoldAsked | null>;
}

export interface HoldResult {
  outcome: HoldOutcome;
  answer?: HoldAnswer;
  /** Set when a session grant answered this without asking anybody. */
  fromSessionGrant?: true;
  /** The replacement command, when a person edited it. Never run without ruling on it. */
  edited?: string;
}

export function isAllowed(result: HoldResult): boolean {
  return result.outcome === HOLD_OUTCOME.ALLOWED;
}

/**
 * Grants live for one session and in memory only. A grant that survived a restart
 * would be a permission nobody remembers giving, which is the thing policy files are
 * for and this is not.
 */
export class HoldService {
  private readonly granted = new Map<string, Set<string>>();

  constructor(
    private readonly prompt: HoldPrompt,
    private readonly timeoutMs: number = DEFAULT_HOLD_TIMEOUT_MS,
  ) {}

  /** Whether this exact call was already answered "for this session". */
  hasSessionGrant(request: HoldRequest): boolean {
    const grants = this.granted.get(request.sessionId);
    if (grants === undefined) return false;
    return grants.has(request.fingerprint);
  }

  async hold(request: HoldRequest): Promise<HoldResult> {
    if (this.hasSessionGrant(request)) {
      return {
        outcome: HOLD_OUTCOME.ALLOWED,
        answer: HOLD_ANSWER.SESSION,
        fromSessionGrant: true,
      };
    }

    let asked: HoldAsked | null;
    try {
      asked = await this.prompt.ask(request, this.timeoutMs);
    } catch {
      /* A prompt that threw is a prompt nobody saw. Failing closed is the only safe
         reading, and it is reported as unattended rather than as somebody's denial. */
      return { outcome: HOLD_OUTCOME.UNATTENDED };
    }

    if (asked === null) return { outcome: HOLD_OUTCOME.UNATTENDED };
    const answer = asked.answer;
    if (answer === HOLD_ANSWER.DENY) {
      return { outcome: HOLD_OUTCOME.DENIED, answer };
    }
    /* An edit is not an approval of anything: the replacement goes back through the
       rules from the start, or "[e]" would be the way around every one of them. */
    if (answer === HOLD_ANSWER.EDIT) {
      const edited = asked.command?.trim() ?? '';
      if (edited === '' || edited === request.command) {
        return { outcome: HOLD_OUTCOME.DENIED, answer: HOLD_ANSWER.DENY };
      }
      return { outcome: HOLD_OUTCOME.EDITED, answer, edited };
    }
    if (answer === HOLD_ANSWER.SESSION) {
      const grants = this.granted.get(request.sessionId) ?? new Set<string>();
      grants.add(request.fingerprint);
      this.granted.set(request.sessionId, grants);
    }
    return { outcome: HOLD_OUTCOME.ALLOWED, answer };
  }

  /** Ends a session's grants. Called when the session does. */
  forget(sessionId: string): void {
    this.granted.delete(sessionId);
  }
}

/** What the caller is told when a hold did not end in an allow. */
export function describeHold(result: HoldResult, request: HoldRequest): string {
  const what =
    request.target === undefined
      ? request.operation
      : `${request.operation} ${request.target}`;
  if (result.outcome === HOLD_OUTCOME.DENIED) {
    return `A person denied ${what}.`;
  }
  if (result.outcome === HOLD_OUTCOME.EDITED) {
    return `A person replaced that command with: ${result.edited ?? ''}`;
  }
  if (result.outcome === HOLD_OUTCOME.TIMED_OUT) {
    return `Nobody answered in time, so ${what} did not run. Ask again when someone is at the keyboard.`;
  }
  return `${what} needs a person to approve it and there is no terminal to ask at. Run the agent under "memnox run", or add a rule that allows it.`;
}
