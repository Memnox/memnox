import type {
  ActionRequest,
  Alternative,
  DecisionEffect,
  MatchedPolicy,
} from '@memnox/core';
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
  /** What a observed rule would have decided, had it been enforcing. */
  shadowEffect?: DecisionEffect;
  /**
   * Resolved from the rule that withheld, never invented. Without it an offline
   * refusal is a dead end, and an agent told only no abandons the task.
   */
  alternative?: Alternative;
}

/** Evaluated where the call is made, so arguments never travel; only ids and signals do. */
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
      ...(evaluation.shadowEffect === undefined
        ? {}
        : { shadowEffect: evaluation.shadowEffect }),
      ...(evaluation.alternative === undefined
        ? {}
        : { alternative: evaluation.alternative }),
    };
  }
}
