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

/**
 * Policy decided on this machine, on the call's own arguments. It is what makes
 * argument-level rules possible without shipping the payload anywhere — see
 * LocalGate.
 */
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
        return { effect: DECISION_EFFECT.ALLOW, reason: decision.reason };
      }
      const approvalHint = decision.approvalId
        ? ` Approval pending: memnox approvals resolve ${decision.approvalId} --by <you>.`
        : '';
      return { effect: decision.effect, reason: `${decision.reason}.${approvalHint}` };
    } catch (err) {
      if (this.options.failOpen) {
        this.options.log(`runtime unreachable, failing open: ${String(err)}`);
        return {
          effect: DECISION_EFFECT.ALLOW,
          reason: 'runtime unreachable (fail-open)',
        };
      }
      return {
        effect: DECISION_EFFECT.BLOCK,
        reason:
          'Memnox runtime unreachable — failing closed. Start it or set MEMNOX_MCP_FAIL_OPEN=true.',
      };
    }
  }
}

/**
 * Local gate first, runtime second, strictest wins. The local pass is what sees
 * the arguments, so its findings travel to the runtime as signals — and a call
 * the local pass already blocked never becomes a request at all.
 */
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
