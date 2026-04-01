import type { DecisionEffect } from '../constants/decision.constants';
import type { RiskLevel } from '../constants/risk.constants';
import type { Advisory } from './advisory';

export interface MatchedPolicy {
  name: string;
  effect: DecisionEffect;
  reason?: string;
  approvers?: string[];
  minApprovals?: number;
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
