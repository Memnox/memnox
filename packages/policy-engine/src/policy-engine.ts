import type {
  ActionRequest,
  DecisionEffect,
  MatchedPolicy,
  RiskLevel,
} from '@memnox/core';
import {
  DECISION_EFFECT,
  DECISION_REASON,
  EFFECT_PRECEDENCE,
  normalizeActionRequest,
} from '@memnox/core';
import { matchesAny } from './pattern-matcher';
import { matchesAnyTimeWindow } from './time-window';
import { classifyRisk } from './risk-classifier';
import { versionPolicySet } from './policy-version';
import { POLICY_MODE, type Policy } from './policy';

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
  /** What the observed rules would have decided, when that is stricter than the effect. */
  shadowEffect?: DecisionEffect;
}

export interface PolicyEngineOptions {
  /** Effect applied when no policy matches. Defaults to allow (monitor-first onboarding). */
  defaultEffect?: DecisionEffect;
}

/** Most restrictive effect wins. No network, no LLM, no randomness. */
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

  /** Bucketing by first segment keeps the scan proportional to plausible rules, not all. */
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

  evaluate(incoming: ActionRequest, context: EvaluationContext): EvaluationResult {
    /* Here rather than in a caller, because callers are the problem: the runtime
       gateway is one, the in-process gate another, and a padded name only had to
       miss the rule naming it once to turn a block into an allow. */
    const request = normalizeActionRequest(incoming);
    const riskLevel = classifyRisk(request.action, request.environment);
    const matchedPolicies = this.candidates(request.action)
      .filter((policy) => this.matches(policy, request, context))
      .map(toMatchedPolicy);

    // A observed rule is recorded but never decides, so the verdict comes from
    // the enforcing ones alone — and their absence means no rule decided at all.
    const enforcing = matchedPolicies.filter((policy) => policy.observed !== true);
    const shadowEffect = strictestMonitored(matchedPolicies);

    if (enforcing.length === 0) {
      return {
        effect: this.defaultEffect,
        riskLevel,
        reason: DECISION_REASON.NO_POLICY_MATCHED,
        matchedPolicies,
        ...withheld(this.defaultEffect, shadowEffect),
      };
    }

    const winner = enforcing.reduce((mostRestrictive, candidate) =>
      EFFECT_PRECEDENCE[candidate.effect] > EFFECT_PRECEDENCE[mostRestrictive.effect]
        ? candidate
        : mostRestrictive,
    );
    return {
      effect: winner.effect,
      riskLevel,
      reason: winner.reason ?? `policy "${winner.name}" applied`,
      matchedPolicies,
      ...withheld(winner.effect, shadowEffect),
    };
  }

  /** One project's rule never decides another's; an unscoped rule is the baseline. */
  private inScope(policy: Policy, request: ActionRequest): boolean {
    if (policy.project === undefined) return true;
    return policy.project === request.projectId;
  }

  private matches(
    policy: Policy,
    request: ActionRequest,
    context: EvaluationContext,
  ): boolean {
    return (
      this.inScope(policy, request) &&
      matchesAny(policy.match.actions, request.action) &&
      matchesAny(policy.match.targets, request.target) &&
      matchesAny(policy.match.environments, request.environment) &&
      matchesAny(policy.match.agents, context.agentName) &&
      matchesAny(policy.match.principals, request.principal) &&
      matchesAny(policy.match.models, request.model) &&
      matchesAny(policy.match.providers, request.provider) &&
      matchesAny(policy.match.dataClassifications, request.dataClassification) &&
      matchesAny(policy.match.jurisdictions, request.jurisdiction) &&
      matchesAny(policy.match.workingDirectories, request.workingDirectory) &&
      matchesAny(policy.match.branches, request.branch) &&
      matchesAllArguments(policy.match.arguments, request.arguments) &&
      matchesAmount(policy.match.aboveAmount, request.amount) &&
      matchesAnyTimeWindow(policy.match.windows, context.now)
    );
  }
}

function toMatchedPolicy(policy: Policy): MatchedPolicy {
  const observed = policy.decision.mode === POLICY_MODE.MONITOR;
  return {
    name: policy.name,
    effect: policy.decision.effect,
    reason: policy.decision.reason,
    approvers: policy.decision.approvers,
    minApprovals: policy.decision.minApprovals,
    ...(observed ? { observed } : {}),
    ...(policy.decision.rateLimit === undefined
      ? {}
      : { rateLimit: policy.decision.rateLimit }),
  };
}

function strictestMonitored(matched: MatchedPolicy[]): DecisionEffect | undefined {
  return matched
    .filter((policy) => policy.observed === true)
    .map((policy) => policy.effect)
    .reduce<DecisionEffect | undefined>(
      (strictest, effect) =>
        strictest === undefined ||
        EFFECT_PRECEDENCE[effect] > EFFECT_PRECEDENCE[strictest]
          ? effect
          : strictest,
      undefined,
    );
}

/** Reporting a withheld effect no stricter than the applied one would be noise. */
function withheld(
  applied: DecisionEffect,
  observed: DecisionEffect | undefined,
): { shadowEffect?: DecisionEffect } {
  if (observed === undefined) return {};
  if (EFFECT_PRECEDENCE[observed] <= EFFECT_PRECEDENCE[applied]) return {};
  return { shadowEffect: observed };
}

/** Each named argument narrows the rule further — all of them must hold. */
/** An unstated amount matches: it cannot prove it is under the line. */
function matchesAmount(
  threshold: number | undefined,
  amount: number | undefined,
): boolean {
  if (threshold === undefined) return true;
  if (amount === undefined) return true;
  return amount > threshold;
}

function matchesAllArguments(
  patterns: Record<string, string[]> | undefined,
  values: Record<string, string> | undefined,
): boolean {
  if (patterns === undefined) return true;
  const supplied = values === undefined ? {} : values;
  return Object.entries(patterns).every(([name, allowed]) =>
    matchesAny(allowed, supplied[name]),
  );
}

const SEGMENT_SEPARATOR = '.';
const WILDCARD = '*';

function firstSegment(value: string): string {
  const index = value.indexOf(SEGMENT_SEPARATOR);
  return index === -1 ? value : value.slice(0, index);
}

/** Null when a pattern could match anything, so the index only ever narrows work. */
function literalPrefixes(patterns: string[]): Set<string> | null {
  const prefixes = new Set<string>();
  for (const pattern of patterns) {
    const prefix = firstSegment(pattern);
    if (prefix.includes(WILDCARD) || prefix.length === 0) return null;
    prefixes.add(prefix.toLowerCase());
  }
  return prefixes.size === 0 ? null : prefixes;
}
