import type { DecisionEffect } from '@memnox/core';
import { DECISION_EFFECT, EFFECT_PRECEDENCE } from '@memnox/core';
import type { LocalGate } from '@memnox/local-gate';
import type { MemnoxClient } from '@memnox/sdk';
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

export interface RuntimeAuthorizerOptions {
  serverName: string;
  sessionId?: string;
  /** Forward calls when the runtime is unreachable. Default false — a firewall fails closed. */
  failOpen?: boolean;
  log: (message: string) => void;
}

export class RuntimeAuthorizer implements CallAuthorizer {
  constructor(
    private readonly client: MemnoxClient,
    private readonly options: RuntimeAuthorizerOptions,
  ) {}

  async authorize(call: ToolCall, signals: string[] = []): Promise<CallVerdict> {
    try {
      // The tool name, the server, and what the local pass found — the arguments
      // themselves stay on this machine and are never part of this request.
      const decision = await this.client.check({
        action: `${MCP_ACTION_PREFIX}.${call.name}`,
        target: this.options.serverName,
        sessionId: this.options.sessionId,
        ...(signals.length > 0 ? { signals } : {}),
      });
      if (decision.effect === DECISION_EFFECT.ALLOW) {
        return {
          effect: DECISION_EFFECT.ALLOW,
          reason: decision.reason,
          decisionId: decision.eventId,
        };
      }
      const approvalHint = decision.approvalId
        ? ` Approval pending: memnox approvals resolve ${decision.approvalId} --by <you>.`
        : '';
      // The alternative rides all the way to the client, or the refusal is a dead end.
      return {
        effect: decision.effect,
        reason: `${decision.reason}.${approvalHint}`,
        decisionId: decision.eventId,
        ...(decision.alternative === undefined
          ? {}
          : { alternative: decision.alternative }),
      };
    } catch (err) {
      if (this.options.failOpen) {
        this.options.log(`runtime unreachable, failing open: ${String(err)}`);
        return {
          effect: DECISION_EFFECT.ALLOW,
          reason: 'runtime unreachable (fail-open)',
        };
      }
      return {
        effect: DECISION_EFFECT.WITHHOLD,
        reason:
          'Memnox runtime unreachable — failing closed. Start it or set MEMNOX_MCP_FAIL_OPEN=true.',
      };
    }
  }
}

/** Local first, runtime second, strictest wins; a local block never becomes a request. */
export class LayeredAuthorizer implements CallAuthorizer {
  constructor(
    private readonly local: LocalGateAuthorizer,
    private readonly runtime: RuntimeAuthorizer,
  ) {}

  async authorize(call: ToolCall): Promise<CallVerdict> {
    const localVerdict = await this.local.authorize(call);
    if (!isAllowed(localVerdict)) return localVerdict;

    const remote = await this.runtime.authorize(call, localVerdict.signals ?? []);
    return EFFECT_PRECEDENCE[remote.effect] > EFFECT_PRECEDENCE[localVerdict.effect]
      ? remote
      : localVerdict;
  }
}
