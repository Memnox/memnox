import type { ActionRequest, DecisionEffect, MatchedPolicy } from '@memnox/core';
import { DECISION_EFFECT } from '@memnox/core';
import { PolicyEngine, type Policy } from '@memnox/policy-engine';
import { loadPolicyFiles } from './policy-file';

const SIGNAL_POLICY_PREFIX = 'policy:';

export interface LocalGateOptions {
  /** Matched against a rule's `agents` patterns, exactly as the runtime does. */
  agentName: string;
  /** Effect when no rule matches. Defaults to allow — the runtime is still asked. */
  defaultEffect?: DecisionEffect;
  /** Supplied by the caller so a verdict stays reproducible on replay. */
  now?: Date;
}

export interface LocalVerdict {
  effect: DecisionEffect;
  reason: string;
  /** Findings safe to send onward — rule ids only, never the matched text. */
  signals: string[];
  matchedPolicies: MatchedPolicy[];
  /** What a monitored rule would have decided, had it been enforcing. */
  withheldEffect?: DecisionEffect;
}

/**
 * Policy evaluated in the process that makes the call, so a verdict on the
 * call's own arguments never requires them to travel. Only rule ids and
 * signals leave the machine.
 *
 * It does not replace the runtime — it runs before it, and the strictest of the
 * two verdicts is what the enforcement point applies. Rate limits are the
 * runtime's alone: a per-process counter is not a limit.
 */
export class LocalGate {
  private readonly engine: PolicyEngine;

  constructor(
    policies: readonly Policy[],
    private readonly options: LocalGateOptions,
  ) {
    this.engine = new PolicyEngine([...policies], {
      defaultEffect: options.defaultEffect ?? DECISION_EFFECT.ALLOW,
    });
  }

  /** Loads the same policy files the runtime reads, from this machine's disk. */
  static async fromFiles(
    filePaths: readonly string[],
    options: LocalGateOptions,
  ): Promise<LocalGate> {
    return new LocalGate(await loadPolicyFiles(filePaths), options);
  }

  /** The rule set in force locally — for `memnox policy` style reporting. */
  rules(): Policy[] {
    return this.engine.rules();
  }

  evaluate(request: ActionRequest): LocalVerdict {
    const evaluation = this.engine.evaluate(request, {
      agentName: this.options.agentName,
      now: this.options.now ?? new Date(),
    });
    return {
      effect: evaluation.effect,
      reason: evaluation.reason,
      signals: evaluation.matchedPolicies.map(
        (policy) => `${SIGNAL_POLICY_PREFIX}${policy.name}`,
      ),
      matchedPolicies: evaluation.matchedPolicies,
      ...(evaluation.withheldEffect === undefined
        ? {}
        : { withheldEffect: evaluation.withheldEffect }),
    };
  }
}
