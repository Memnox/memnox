import {
  classifyToolCall,
  DECISION_EFFECT,
  PROTECTION_STOPPED_REASON,
  type ActionRequest,
  type Alternative,
  type DecisionEffect,
  type LocalGate,
} from '@memnox/core';

import { operationFor } from './ledger';
import { heldReason, type SessionLimits } from './session-limits';
import type { ToolCall } from './tool-call';

/**
 * Whether one tool call may proceed, as a chain: the rules are one link, and a pause, a
 * budget and another machine's claim wrap them, since each must hold with no rule file.
 */

export interface CallVerdict {
  effect: DecisionEffect;
  reason: string;
  /** What the local pass found: rule ids only, safe to send onward. */
  signals?: string[];
  /** What the agent may use instead, carried into the denial the client reads. */
  alternative?: Alternative;
  /** The verdict this came from, so a proxied call joins its decision in the ledger. */
  decisionId?: string;
  /** The rule that decided, by name, so `why` does not answer "none matched". */
  rule?: string;
}

/** Decides whether one tool call may reach the wrapped server. */
export interface CallAuthorizer {
  authorize(call: ToolCall): Promise<CallVerdict>;
  /**
   * The call it allowed has returned. Only an authorizer holding something
   * while the call runs needs this, which is the claim on outward work.
   */
  settle?(call: ToolCall): Promise<void>;
  /** The proxy is going away, so whatever is still held is let go now. */
  close?(): Promise<void>;
  /** A person allowed what this asked about, so the same new thing is not asked twice. */
  personAllowed?(call: ToolCall): void;
}

export function isCallAllowed(verdict: CallVerdict): boolean {
  return verdict.effect === DECISION_EFFECT.ALLOW;
}

/** No runtime configured, so the static tool filters are the only gate. */
export class UngovernedAuthorizer implements CallAuthorizer {
  async authorize(): Promise<CallVerdict> {
    return { effect: DECISION_EFFECT.ALLOW, reason: 'no runtime configured' };
  }
}

/** Outermost: while protection is stopped every call passes, asked per call so a start bites at once. */
export class StoppedAuthorizer implements CallAuthorizer {
  constructor(
    private readonly inner: CallAuthorizer,
    private readonly stopped: () => Promise<boolean>,
  ) {}

  async authorize(call: ToolCall): Promise<CallVerdict> {
    if (await this.stopped()) {
      return { effect: DECISION_EFFECT.ALLOW, reason: PROTECTION_STOPPED_REASON };
    }
    return this.inner.authorize(call);
  }

  async settle(call: ToolCall): Promise<void> {
    await this.inner.settle?.(call);
  }

  async close(): Promise<void> {
    await this.inner.close?.();
  }

  personAllowed(call: ToolCall): void {
    this.inner.personAllowed?.(call);
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
    const verdict = this.gate.evaluate(this.requestFor(call));
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

  personAllowed(call: ToolCall): void {
    this.gate.personAllowed(this.requestFor(call));
  }

  private requestFor(call: ToolCall): ActionRequest {
    return {
      action: operationFor(call.name),
      target: this.serverName,
      // By name and statement, since the proxy keeps no manifest and a `query` can drop.
      toolClass: classifyToolCall(call.name, call.arguments).class,
      arguments: call.arguments,
      ...(this.sessionId === undefined ? {} : { sessionId: this.sessionId }),
    };
  }
}

/**
 * A pause and a budget, asked before the rules, around whatever
 * authorizer this proxy has. The pause first, since a budget
 * message sends somebody editing allowances, not at the loop.
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

    // The action string the gate matches on, so
    // one budget covers a call and its shell twin.
    const spent = await this.limits.exhausted(operationFor(call.name), sessionId);
    if (spent !== null) return { effect: DECISION_EFFECT.DENY, reason: spent };

    return this.inner.authorize(call);
  }

  personAllowed(call: ToolCall): void {
    this.inner.personAllowed?.(call);
  }
}
