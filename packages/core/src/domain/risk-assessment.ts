import type { Advisory } from './advisory';
import type { MatchedPolicy } from './decision';
import type { DecisionEffect } from '../constants/decision.constants';
import type { RiskLevel } from '../constants/risk.constants';

/** A decision that was not made — same pipeline as authorize, nothing recorded. */
export interface RiskAssessment {
  effect: DecisionEffect;
  riskLevel: RiskLevel;
  reason: string;
  matchedPolicies: MatchedPolicy[];
  advisories: Advisory[];
  /** The named level this agent holds. A level is granted; a score would be inferred. */
  autonomyLevel?: number;
}
