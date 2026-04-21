import type { DecisionEffect, RiskLevel } from '@memnox/core';
import { DECISION_EFFECT, EFFECT_PRECEDENCE } from '@memnox/core';
import { PolicyEngine } from './policy-engine';

/** One action to evaluate. Mirrors the fields a policy can match on. */
export interface SimulationCase {
  action: string;
  target?: string;
  environment?: string;
  agentName?: string;
}

export interface CaseOutcome {
  case: SimulationCase;
  effect: DecisionEffect;
  riskLevel: RiskLevel;
  matchedPolicies: string[];
}

export interface EffectChange {
  case: SimulationCase;
  before: DecisionEffect;
  after: DecisionEffect;
  /** The candidate set is stricter here — the usual reason to ship a change. */
  stricter: boolean;
  matchedPolicies: string[];
}

export interface PolicyComparison {
  total: number;
  unchanged: number;
  changes: EffectChange[];
  /** How many cases land on each effect under the candidate set. */
  candidateTotals: Record<DecisionEffect, number>;
}

const UNKNOWN_AGENT = 'simulated-agent';

const emptyTotals = (): Record<DecisionEffect, number> => ({
  [DECISION_EFFECT.ALLOW]: 0,
  [DECISION_EFFECT.BLOCK]: 0,
  [DECISION_EFFECT.REQUIRE_APPROVAL]: 0,
});

/** Evaluates cases against a rule set without touching identity, advisors, or audit. */
export function simulate(
  engine: PolicyEngine,
  cases: readonly SimulationCase[],
): CaseOutcome[] {
  return cases.map((simulationCase) => {
    const result = engine.evaluate(
      {
        action: simulationCase.action,
        ...(simulationCase.target ? { target: simulationCase.target } : {}),
        ...(simulationCase.environment
          ? { environment: simulationCase.environment }
          : {}),
      },
      { agentName: simulationCase.agentName ?? UNKNOWN_AGENT },
    );
    return {
      case: simulationCase,
      effect: result.effect,
      riskLevel: result.riskLevel,
      matchedPolicies: result.matchedPolicies.map((policy) => policy.name),
    };
  });
}

/**
 * Answers the question that makes a policy change safe to ship: against these
 * actions, what would the candidate rules decide differently?
 *
 * Pair it with real audit history and the answer stops being hypothetical —
 * "this would have blocked 3 of your last 1000 actions, here they are".
 */
export function comparePolicySets(
  baseline: PolicyEngine,
  candidate: PolicyEngine,
  cases: readonly SimulationCase[],
): PolicyComparison {
  const before = simulate(baseline, cases);
  const after = simulate(candidate, cases);
  const candidateTotals = emptyTotals();
  const changes: EffectChange[] = [];

  after.forEach((afterOutcome, index) => {
    candidateTotals[afterOutcome.effect] += 1;
    const beforeDecision = before[index];
    const beforeEffect = beforeDecision === undefined ? undefined : beforeDecision.effect;
    if (beforeEffect === undefined || beforeEffect === afterOutcome.effect) return;
    changes.push({
      case: afterOutcome.case,
      before: beforeEffect,
      after: afterOutcome.effect,
      stricter: EFFECT_PRECEDENCE[afterOutcome.effect] > EFFECT_PRECEDENCE[beforeEffect],
      matchedPolicies: afterOutcome.matchedPolicies,
    });
  });

  return {
    total: cases.length,
    unchanged: cases.length - changes.length,
    changes,
    candidateTotals,
  };
}
