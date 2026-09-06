import type { DecisionEffect } from '@memnox/core';
import { DECISION_EFFECT } from '@memnox/core';
import type { LocalGate } from '@memnox/core';
import { MCP_ACTION_PREFIX } from './firewall.constants';
import { heldReason, type SessionLimits } from './session-limits';
import type { ToolCall } from './tool-call';

export interface CallVerdict {
  effect: DecisionEffect;
  reason: string;
  /** What the local pass found — rule ids only, safe to send onward. */
  signals?: string[];
  /** What the agent may use instead, carried into the denial the client reads. */
  alternative?: { action: string; resource?: string; note: string };
  /** The verdict this came from, so a proxied call joins its decision in the ledger. */
  decisionId?: string;
  /** The rule that decided, by name, so `why` does not answer "none matched". */
  rule?: string;
}

/** Decides whether one tool call may reach the wrapped server. */
export interface CallAuthorizer {
  authorize(call: ToolCall): Promise<CallVerdict>;
}

export function isAllowed(verdict: CallVerdict): boolean {
  return verdict.effect === DECISION_EFFECT.ALLOW;
}

/** No runtime configured — the static tool filters are the only gate. */
export class UngovernedAuthorizer implements CallAuthorizer {
  async authorize(): Promise<CallVerdict> {
    return { effect: DECISION_EFFECT.ALLOW, reason: 'no runtime configured' };
  }
}

/** Argument-level rules without shipping the payload anywhere; see LocalGate. */
export class LocalGateAuthorizer implements CallAuthorizer {
  constructor(
    private readonly gate: LocalGate,
    private readonly serverName: string,
    private readonly sessionId?: string,
  ) {}

  async authorize(call: ToolCall): Promise<CallVerdict> {
    const verdict = this.gate.evaluate({
      action: `${MCP_ACTION_PREFIX}.${call.name}`,
      target: this.serverName,
      arguments: call.arguments,
      ...(this.sessionId === undefined ? {} : { sessionId: this.sessionId }),
    });
    const decided = verdict.matchedPolicies[0];
    return {
      effect: verdict.effect,
      reason: verdict.reason,
      signals: verdict.signals,
      // A local refusal names its alternative too, or offline is a dead end.
      ...(verdict.alternative === undefined ? {} : { alternative: verdict.alternative }),
      ...(decided === undefined ? {} : { rule: decided.name }),
    };
  }
}

/**
 * A pause and a budget, asked before the rules are.
 *
 * Wrapped around whatever authorizer this proxy ended up with rather than folded
 * into `LocalGateAuthorizer`, because neither of these is a policy decision and
 * both must hold on a machine that has no policy file at all. A session the
 * breaker stopped is stopped; a day's allowance that is spent is spent; and
 * `UngovernedAuthorizer` allowing everything is a statement about *rules*, not a
 * statement that nothing else may hold a call back.
 *
 * Order matters. The pause is read first because it is the stronger fact — the
 * session has already been judged to be getting nowhere — and a budget message
 * offered to somebody whose agent is looping would send them editing allowances
 * instead of looking at the loop.
 */
export class SessionLimitedAuthorizer implements CallAuthorizer {
  constructor(
    private readonly inner: CallAuthorizer,
    private readonly limits: SessionLimits,
    private readonly sessionId?: string,
  ) {}

  async authorize(call: ToolCall): Promise<CallVerdict> {
    const sessionId = this.sessionId;
    if (sessionId !== undefined && sessionId !== '') {
      const held = await this.limits.heldBy(sessionId);
      if (held !== null) {
        return { effect: DECISION_EFFECT.DENY, reason: heldReason(held) };
      }
    }

    /* Asked with the same action string the gate matches on, so one budget covers
       a tool call and the shell command that does the same thing. */
    const spent = await this.limits.exhausted(
      `${MCP_ACTION_PREFIX}.${call.name}`,
      sessionId,
    );
    if (spent !== null) return { effect: DECISION_EFFECT.DENY, reason: spent };

    return this.inner.authorize(call);
  }
}
