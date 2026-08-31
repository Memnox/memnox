import type { DecisionEffect } from '../constants/decision.constants';
import type { EnforcementMode } from '../constants/enforcement.constants';
import type { RiskLevel } from '../constants/risk.constants';
import type { Advisory } from './advisory';

/** The ceiling only: counting is stateful, so the gateway owns the counter. */
export interface RateLimitSpec {
  max: number;
  windowSeconds: number;
}

export interface RuleRef {
  id: string;
  name: string;
  version: string;
}

/** Resolved from the rule that withheld, never invented: this is why redirection works. */
export interface Alternative {
  action: string;
  resource?: string;
  note: string;
}

export interface MatchedPolicy {
  name: string;
  effect: DecisionEffect;
  reason?: string;
  approvers?: string[];
  minApprovals?: number;
  /** Set when the rule is in observe mode: it matched, but did not decide. */
  observed?: boolean;
  rateLimit?: RateLimitSpec;
  alternative?: Alternative;
}

export interface Decision {
  /** ULID, assigned locally. Also the audit event id, so a verdict joins its record. */
  eventId: string;
  effect: DecisionEffect;
  /** What enforce WOULD have said. The hinge of observe mode and of simulation. */
  shadowEffect?: DecisionEffect;
  riskLevel: RiskLevel;
  reason: string;
  rule?: RuleRef;
  matchedPolicies: MatchedPolicy[];
  /** Deterministic escalations and signals from advisors (memory conflicts, behavior). */
  advisories: Advisory[];
  /** What the agent may do instead. Small field, most of the product's real work. */
  alternative?: Alternative;
  /** What the caller must do for the allow to stand, e.g. record an outcome. */
  obligations?: string[];
  /** Present when effect is escalate — poll or resolve this approval. */
  approvalId?: string;
  mode: EnforcementMode;
  /** Which compiled rule set decided this, and whether it was the current one. */
  bundleVersion?: string;
  bundleStale?: boolean;
  evaluatedAt: string;
  latencyUs: number;
}
