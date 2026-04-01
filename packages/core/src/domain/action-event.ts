import type { DecisionEffect } from '../constants/decision.constants';
import type { EnforcementMode } from '../constants/enforcement.constants';
import type { RiskLevel } from '../constants/risk.constants';
import type { TaintAssessment } from './taint';

/**
 * The core primitive: every AI action becomes an event that Memnox can
 * understand, evaluate, authorize, and prove.
 */
export interface ActionRequest {
  /** Namespaced verb, e.g. "database.delete", "code.modify", "deploy.service". */
  action: string;
  /** What the action operates on, e.g. "production.users", "payment/checkout.ts". */
  target?: string;
  environment?: string;
  /** Groups actions into one agent session for replay and reporting. */
  sessionId?: string;
  /** Untrusted sources that influenced the agent's context, reported by the caller. */
  taint?: TaintAssessment;
  /** The agent's stated intent — recorded verbatim for the audit trail. */
  reason?: string;
  metadata?: Record<string, unknown>;
  /** Reference to a previously granted approval for this same action. */
  approvalId?: string;
  /** Model behind the action, e.g. "openai.gpt-4". Reported by the caller. */
  model?: string;
  /** Inference provider, e.g. "openai", "anthropic", "bedrock". */
  provider?: string;
  /** What kind of regulated data this touches, e.g. "pii.eu", "hipaa", "pci". */
  dataClassification?: string;
  /** Region the action executes in, e.g. "eu", "us". */
  jurisdiction?: string;
}

export interface ActionEvent {
  id: string;
  occurredAt: string;
  agentId: string;
  agentName: string;
  action: string;
  target?: string;
  environment?: string;
  sessionId?: string;
  taint?: TaintAssessment;
  model?: string;
  provider?: string;
  dataClassification?: string;
  jurisdiction?: string;
  /** What actually happened — in monitor mode this is always allow. */
  effect: DecisionEffect;
  /** Mode in force for this environment when the action was decided. */
  enforcementMode?: EnforcementMode;
  /** What policy decided, when the mode kept it from being applied. */
  withheldEffect?: DecisionEffect;
  riskLevel: RiskLevel;
  matchedPolicies: string[];
  /** Content version of the rule set that decided this — see versionPolicySet. */
  policyVersion?: string;
  /** Names of advisors that escalated or flagged this action. */
  advisories: string[];
  reason: string;
  /** Owning org/workspace; unset = single-tenant deployment. */
  orgId?: string;
  /** Tamper evidence, set by the audit log at append time (see audit-chain). */
  prevHash?: string;
  hash?: string;
}

export interface AuditQuery {
  sessionId?: string;
  agentId?: string;
  orgId?: string;
  from?: string;
  to?: string;
  /** Most recent N matching events, still returned chronologically. Unset = all. */
  limit?: number;
}
