import type { DecisionEffect } from '@memnox/core';
import { DECISION_EFFECT } from '@memnox/core';
import type { LocalGate } from '@memnox/core';
import { MCP_ACTION_PREFIX } from './firewall.constants';
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
    return {
      effect: verdict.effect,
      reason: verdict.reason,
      signals: verdict.signals,
      // A local refusal names its alternative too, or offline is a dead end.
      ...(verdict.alternative === undefined ? {} : { alternative: verdict.alternative }),
    };
  }
}
