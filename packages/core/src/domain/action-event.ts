import type { DecisionEffect } from '../constants/decision.constants';
import type { EnforcementMode } from '../constants/enforcement.constants';
import type { ExecutionStatus } from '../constants/execution.constants';
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
  /**
   * The governance unit this action belongs to. Declared in a policy file, not
   * inferred from the repository — a frontend and a backend repo that declare
   * the same project share one policy and memory scope.
   */
  projectId?: string;
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
  /** Directory the agent is working in, e.g. "/srv/checkout". Reported by the caller. */
  workingDirectory?: string;
  /** Source control branch the work sits on, e.g. "main", "release/24.3". */
  branch?: string;
  /**
   * The call's own arguments, flattened to strings — a tool's `command`, `path`,
   * `query`. LOCAL ONLY: this is the raw payload, so the in-process gate matches
   * on it and the SDK strips it before anything crosses the network. What travels
   * instead is `signals`.
   */
  arguments?: Record<string, string>;
  /**
   * What the local gate already found, e.g. "shield:aws-access-key",
   * "policy:no-rm-rf". Testimony, not evidence: it is audited and may escalate,
   * and can never loosen a verdict the runtime reaches on its own.
   */
  signals?: string[];
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
  /** Governance unit the action resolved to; spans every repo that declares it. */
  projectId?: string;
  taint?: TaintAssessment;
  model?: string;
  provider?: string;
  dataClassification?: string;
  jurisdiction?: string;
  workingDirectory?: string;
  branch?: string;
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
  /**
   * Present only on execution.outcome events — the caller's testimony about an
   * action already allowed, carried verbatim so a decision can be joined to what
   * it actually did. See ExecutionOutcomeReport.
   */
  decisionEventId?: string;
  executionStatus?: ExecutionStatus;
  rolledBack?: boolean;
  /** The compensating action itself failed, so the resulting state is unknown. */
  rollbackFailed?: boolean;
  /** Tamper evidence, set by the audit log at append time (see audit-chain). */
  prevHash?: string;
  hash?: string;
}

export interface AuditQuery {
  sessionId?: string;
  agentId?: string;
  orgId?: string;
  projectId?: string;
  from?: string;
  to?: string;
  /** Most recent N matching events, still returned chronologically. Unset = all. */
  limit?: number;
}
