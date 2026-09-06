import type { DecisionEffect } from '../constants/decision.constants';
import type { ActionRequest } from '../domain/action-event';
import type { Alternative, MatchedPolicy } from '../domain/decision';
import { DECISION_EFFECT } from '../constants/decision.constants';
import { PolicyEngine, type Policy } from '../policy/index';
import { matchesAny } from '../policy/pattern-matcher';
import { scopeOf, type SessionTask } from '../session/session-task';
import { SCOPE_MATCH, type ScopeComparison } from '../domain/task';
import { loadPolicyFiles } from './policy-file';

const SIGNAL_POLICY_PREFIX = 'policy:';

export interface LocalGateOptions {
  /** Matched against a rule's `agents` patterns, exactly as the runtime does. */
  agentName: string;
  /**
   * The job this agent was enrolled under, matched by a rule's `roles`. A workforce
   * is several agents with different authority, and without this a `roles` rule
   * parses, validates and then never fires — which reads as working and is worse
   * than absent.
   */
  agentRole?: string;
  /**
   * What somebody asked for, so a rule can match on `scope`. Null is `undeclared`
   * rather than out of scope: most sessions declare nothing and treating those as
   * drift would make the signal worthless.
   */
  task?: SessionTask | null;
  /** Effect when no rule matches. Defaults to allow — the runtime is still asked. */
  defaultEffect?: DecisionEffect;
  /** Supplied by the caller so a verdict stays reproducible on replay. */
  now?: Date;
  /**
   * What is in force, handed in rather than queried. A gate that cannot see a freeze
   * allows through the one action the freeze was declared for, which is the failure
   * that makes the next freeze get ignored.
   */
  stateFacts?: readonly string[];
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
   * Resolved from the rule that denied, never invented. Without it an offline
   * refusal is a dead end, and an agent told only no abandons the task.
   */
  alternative?: Alternative;
  /** How this sat against the declared task, so a caller can report drift. */
  scope?: ScopeComparison;
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
    const at = this.options.now ?? new Date();
    const drift = scopeOf(this.options.task ?? null, request, (patterns, value) =>
      matchesAny([...patterns], value),
    );
    const evaluation = this.engine.evaluate(request, {
      agentName: this.options.agentName,
      now: at,
      ...(this.options.agentRole === undefined
        ? {}
        : { agentRole: this.options.agentRole }),
      ...(drift.match === SCOPE_MATCH.UNDECLARED ? {} : { scope: drift.match }),
      ...(this.options.stateFacts === undefined
        ? {}
        : { state: this.options.stateFacts }),
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
      ...(drift.match === SCOPE_MATCH.UNDECLARED ? {} : { scope: drift }),
    };
  }
}
