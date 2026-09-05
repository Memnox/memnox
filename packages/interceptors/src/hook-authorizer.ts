import type { ActionRequest, Alternative, DecisionEffect } from '@memnox/core';
import { DECISION_EFFECT, describeEgress, inspectEgress } from '@memnox/core';
import type { LocalGate } from '@memnox/core';
import { EGRESS_ACTIONS } from './tool-hook.constants';

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
    if (local !== null && local.effect === DECISION_EFFECT.DENY) {
      return local;
    }

    return local ?? { effect: DECISION_EFFECT.ALLOW, reason: 'no rules configured' };
  }

  // Nothing is modified: silently stripping a payload is a bug nobody can audit.
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
      effect: DECISION_EFFECT.DENY,
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
}
