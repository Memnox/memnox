import type { ActionRequest, Alternative, DecisionEffect } from '@memnox/core';
import {
  DECISION_EFFECT,
  describeEgress,
  EFFECT_PRECEDENCE,
  inspectEgress,
} from '@memnox/core';
import type { LocalGate } from '@memnox/local-gate';
import type { MemnoxClient } from '@memnox/sdk';
import { EGRESS_ACTIONS } from './tool-hook.constants';
import { FRAME_TOOL_CALL } from './tool-hook.constants';

export interface HookVerdict {
  effect: DecisionEffect;
  reason: string;
  /** What the agent may use instead, carried into the denial the model reads. */
  alternative?: Alternative;
  /** The rule that matched, so a reported verdict cites rather than asserts. */
  rule?: string;
  /** Present when a person has to answer; printed so the terminal can resolve it. */
  approvalId?: string;
  /** The verdict this came from, so a hooked call joins its decision in the ledger. */
  decisionId?: string;
  /**
   * Set when nobody could be asked, rather than when somebody said no. A seam that
   * can only ever subtract needs to tell those apart before it decides what to do.
   */
  unreachable?: true;
}

export interface HookAuthorizerDeps {
  /** Evaluated in-process against this machine's policy files; sees the arguments. */
  gate?: LocalGate;
  /** The runtime, which alone can resolve an alternative and raise an approval. */
  client?: MemnoxClient;
  /** Allow the tool when the runtime is unreachable. Default false — fail closed. */
  failOpen?: boolean;
  /** Which seam is reporting, so coverage and drift can tell them apart. */
  seam?: string;
  log: (message: string) => void;
}

/**
 * Local first, runtime second, strictest wins — the same order the MCP seam uses. A
 * local refusal never becomes a network request, so the arguments that produced it
 * stay on this machine.
 */
export class HookAuthorizer {
  constructor(private readonly deps: HookAuthorizerDeps) {}

  async authorize(request: ActionRequest): Promise<HookVerdict> {
    // Destination and payload, both, and before anything leaves this machine: an
    // allowed host carrying a credential is still a refusal.
    const leaking = this.egress(request);
    if (leaking !== null) return leaking;

    const local = this.locally(request);
    if (local !== null && local.effect === DECISION_EFFECT.WITHHOLD) {
      // Reported after the refusal, never before it: the payload stays on this
      // machine, and the ledger still gets a record `why` can read back.
      this.reportLocalVerdict(request, local);
      return local;
    }

    const client = this.deps.client;
    if (client === undefined) {
      // No runtime configured: the local rules are the only gate, and say so.
      return local ?? { effect: DECISION_EFFECT.ALLOW, reason: 'no runtime configured' };
    }

    const remote = await this.remotely(client, request, local);
    if (local === null) return remote;
    return EFFECT_PRECEDENCE[remote.effect] >= EFFECT_PRECEDENCE[local.effect]
      ? remote
      : local;
  }

  /**
   * Nothing is modified — silently stripping a payload is a bug the agent cannot see
   * and the reader cannot audit — so this refuses and names the field it found.
   */
  private egress(request: ActionRequest): HookVerdict | null {
    if (!EGRESS_ACTIONS.includes(request.action)) return null;
    const fields = request.arguments;
    if (fields === undefined) return null;

    const inspection = inspectEgress({
      ...(request.target === undefined ? {} : { destination: request.target }),
      fields,
    });
    if (inspection.findings.length === 0) return null;

    return {
      effect: DECISION_EFFECT.WITHHOLD,
      reason: describeEgress(inspection),
      alternative: {
        action: request.action,
        note: 'send the request without that field, or reference the value by name',
      },
    };
  }

  /** Null when no policy files were configured, which leaves the runtime as the gate. */
  private locally(request: ActionRequest): HookVerdict | null {
    const gate = this.deps.gate;
    if (gate === undefined) return null;

    const verdict = gate.evaluate(request);
    const rule = verdict.matchedPolicies[0];
    return {
      effect: verdict.effect,
      reason: verdict.reason,
      ...(rule === undefined ? {} : { rule: rule.name }),
      ...(verdict.alternative === undefined ? {} : { alternative: verdict.alternative }),
    };
  }

  /**
   * A refusal this seam made alone. Without it the ledger has no note of the strongest
   * thing the product does, and `memnox why` has nothing to explain.
   */
  private reportLocalVerdict(request: ActionRequest, verdict: HookVerdict): void {
    const client = this.deps.client;
    if (client === undefined) return;
    // Wrapped, not just caught: a throw here is synchronous and would turn a refusal
    // into a crash. The record is worth having, never at the cost of the verdict.
    try {
      void client
        .reportDecision({
          action: request.action,
          ...(request.target === undefined ? {} : { target: request.target }),
          effect: verdict.effect,
          reason: verdict.reason,
          ...(verdict.rule === undefined ? {} : { rule: verdict.rule }),
          ...(request.sessionId === undefined ? {} : { sessionId: request.sessionId }),
          seam: this.deps.seam ?? 'hook',
        })
        .catch((err: unknown) => {
          this.deps.log(`verdict not recorded: ${String(err)}`);
        });
    } catch (err) {
      this.deps.log(`verdict not recorded: ${String(err)}`);
    }
  }

  /**
   * What this seam saw, so a session is one timeline. Fire-and-forget: a ledger that is
   * briefly unreachable must never hold up the tool call the agent is waiting on.
   */
  private reportFrame(
    client: MemnoxClient,
    request: ActionRequest,
    decisionId: string,
  ): void {
    const sessionId = request.sessionId;
    if (sessionId === undefined) return;
    void client
      .reportFrame({
        sessionId,
        decisionId,
        kind: FRAME_TOOL_CALL,
        summary:
          request.target === undefined
            ? request.action
            : `${request.action} ${request.target}`,
      })
      .catch((err: unknown) => {
        this.deps.log(`frame not recorded: ${String(err)}`);
      });
  }

  private async remotely(
    client: MemnoxClient,
    request: ActionRequest,
    local: HookVerdict | null,
  ): Promise<HookVerdict> {
    try {
      // The SDK strips `arguments`; only the identity fields and the local findings
      // travel, so a shell command's text never leaves this machine.
      const decision = await client.check(request);
      this.reportFrame(client, request, decision.eventId);
      return {
        effect: decision.effect,
        reason: decision.reason,
        decisionId: decision.eventId,
        ...(decision.alternative === undefined
          ? {}
          : { alternative: decision.alternative }),
        ...(decision.approvalId === undefined ? {} : { approvalId: decision.approvalId }),
      };
    } catch (err) {
      if (this.deps.failOpen === true) {
        this.deps.log(`runtime unreachable, failing open: ${String(err)}`);
        return {
          effect: DECISION_EFFECT.ALLOW,
          reason: 'runtime unreachable (fail-open)',
        };
      }
      this.deps.log(`runtime unreachable, failing closed: ${String(err)}`);
      // A local allow is not evidence the runtime would have allowed it.
      return {
        effect: DECISION_EFFECT.WITHHOLD,
        unreachable: true,
        reason:
          local === null || local.effect === DECISION_EFFECT.ALLOW
            ? 'Memnox runtime unreachable — failing closed. Start it with "memnox setup", or set MEMNOX_HOOK_FAIL_OPEN=true.'
            : local.reason,
      };
    }
  }
}
