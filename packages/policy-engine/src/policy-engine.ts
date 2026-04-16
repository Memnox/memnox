import type {
  ActionRequest,
  DecisionEffect,
  MatchedPolicy,
  RiskLevel,
} from '@memnox/core';
import { DECISION_EFFECT, DECISION_REASON, EFFECT_PRECEDENCE } from '@memnox/core';
import { matchesAny } from './pattern-matcher';
import { matchesAnyTimeWindow } from './time-window';
import { classifyRisk } from './risk-classifier';
import { versionPolicySet } from './policy-version';
import type { Policy } from './policy';

export interface EvaluationContext {
  agentName: string;
  /** Supplied by the caller so a verdict stays reproducible on replay. */
  now?: Date;
}

export interface EvaluationResult {
  effect: DecisionEffect;
  riskLevel: RiskLevel;
  reason: string;
  matchedPolicies: MatchedPolicy[];
}

export interface PolicyEngineOptions {
  /** Effect applied when no policy matches. Defaults to allow (monitor-first onboarding). */
  defaultEffect?: DecisionEffect;
}

/**
 * Deterministic evaluation: every matching policy is collected and the most
 * restrictive effect wins. No network, no LLM, no randomness — same input,
 * same decision, every time.
 */
export class PolicyEngine {
  private readonly defaultEffect: DecisionEffect;
  /** Content version of this rule set, stamped onto every event it decides. */
  readonly version: string;
  /** Policies whose action patterns all start with a literal segment. */
  private readonly byActionPrefix = new Map<string, Policy[]>();
  /** Patterns whose first segment is not literal — candidates for every action. */
  private readonly unindexed: Policy[] = [];

  constructor(
    private readonly policies: Policy[],
    options: PolicyEngineOptions = {},
  ) {
    this.defaultEffect = options.defaultEffect ?? DECISION_EFFECT.ALLOW;
    this.version = versionPolicySet(policies).version;
    this.buildIndex();
  }

  /**
   * Without this, evaluation scans every rule: 10k policies measured p99 7ms.
   * Bucketing by the action's first segment keeps the scan proportional to the
   * rules that could possibly match, not to the size of the rule set.
   */
  private buildIndex(): void {
    for (const policy of this.policies) {
      const prefixes = literalPrefixes(policy.match.actions);
      if (prefixes === null) {
        this.unindexed.push(policy);
        continue;
      }
      for (const prefix of prefixes) {
        const bucket = this.byActionPrefix.get(prefix);
        if (bucket === undefined) this.byActionPrefix.set(prefix, [policy]);
        else bucket.push(policy);
      }
    }
  }

  /** Every rule that could match this action — a superset, never a filter. */
  private candidates(action: string): Policy[] {
    const bucket = this.byActionPrefix.get(firstSegment(action).toLowerCase());
    if (bucket === undefined) return this.unindexed;
    return [...bucket, ...this.unindexed];
  }

  /** The active rule set, copied so a caller cannot mutate what the engine evaluates. */
  rules(): Policy[] {
    return [...this.policies];
  }

  evaluate(request: ActionRequest, context: EvaluationContext): EvaluationResult {
    const riskLevel = classifyRisk(request.action, request.environment);
    const matchedPolicies = this.candidates(request.action)
      .filter((policy) => this.matches(policy, request, context))
      .map((policy): MatchedPolicy => ({
        name: policy.name,
        effect: policy.decision.effect,
        reason: policy.decision.reason,
        approvers: policy.decision.approvers,
        minApprovals: policy.decision.minApprovals,
      }));

    if (matchedPolicies.length === 0) {
      return {
        effect: this.defaultEffect,
        riskLevel,
        reason: DECISION_REASON.NO_POLICY_MATCHED,
        matchedPolicies,
      };
    }

    const winner = matchedPolicies.reduce((mostRestrictive, candidate) =>
      EFFECT_PRECEDENCE[candidate.effect] > EFFECT_PRECEDENCE[mostRestrictive.effect]
        ? candidate
        : mostRestrictive,
    );
    return {
      effect: winner.effect,
      riskLevel,
      reason: winner.reason ?? `policy "${winner.name}" applied`,
      matchedPolicies,
    };
  }

  private matches(
    policy: Policy,
    request: ActionRequest,
    context: EvaluationContext,
  ): boolean {
    return (
      matchesAny(policy.match.actions, request.action) &&
      matchesAny(policy.match.targets, request.target) &&
      matchesAny(policy.match.environments, request.environment) &&
      matchesAny(policy.match.agents, context.agentName) &&
      matchesAny(policy.match.models, request.model) &&
      matchesAny(policy.match.providers, request.provider) &&
      matchesAny(policy.match.dataClassifications, request.dataClassification) &&
      matchesAny(policy.match.jurisdictions, request.jurisdiction) &&
      matchesAnyTimeWindow(policy.match.windows, context.now)
    );
  }
}

const SEGMENT_SEPARATOR = '.';
const WILDCARD = '*';

function firstSegment(value: string): string {
  const index = value.indexOf(SEGMENT_SEPARATOR);
  return index === -1 ? value : value.slice(0, index);
}

/**
 * The literal first segments a pattern list can match, or null when any pattern
 * could match anything — a wildcard first segment must stay unindexed so the
 * index only ever narrows work, never the result.
 */
function literalPrefixes(patterns: string[]): Set<string> | null {
  const prefixes = new Set<string>();
  for (const pattern of patterns) {
    const prefix = firstSegment(pattern);
    if (prefix.includes(WILDCARD) || prefix.length === 0) return null;
    prefixes.add(prefix.toLowerCase());
  }
  return prefixes.size === 0 ? null : prefixes;
}
