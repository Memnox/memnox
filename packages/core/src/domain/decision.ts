import type { DecisionEffect } from '../constants/decision.constants';
import type { RiskLevel } from '../constants/risk.constants';
import type { Advisory } from './advisory';

/**
 * How many times a rule may fire before it stops allowing. Counting is stateful,
 * so the engine only carries the ceiling — the gateway owns the counter.
 */
export interface RateLimitSpec {
  max: number;
  windowSeconds: number;
}

export interface MatchedPolicy {
  name: string;
  effect: DecisionEffect;
  reason?: string;
  approvers?: string[];
  minApprovals?: number;
  /** Set when the rule is in monitor mode: it matched, but did not decide. */
  monitored?: boolean;
  rateLimit?: RateLimitSpec;
}

export interface Decision {
  eventId: string;
  effect: DecisionEffect;
  riskLevel: RiskLevel;
  reason: string;
  matchedPolicies: MatchedPolicy[];
  /** Deterministic escalations and signals from advisors (memory conflicts, behavior). */
  advisories: Advisory[];
  /** Present when effect is require_approval — poll or resolve this approval. */
  approvalId?: string;
  /** What policy decided when the environment's mode kept it from being applied. */
  withheldEffect?: DecisionEffect;
}
