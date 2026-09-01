import type { DecisionEffect } from '../constants/decision.constants';
import type { EnforcementMode } from '../constants/enforcement.constants';
import type { ExecutionStatus } from '../constants/execution.constants';
import type { RiskLevel } from '../constants/risk.constants';
import type { ContextBlock } from './context-block';
import type { TaintAssessment } from './taint';
import type { TaskRef } from './task';

/** The core primitive: every AI action becomes an event Memnox can rule on and prove. */
export interface ActionRequest {
  /** Namespaced verb, e.g. "database.delete", "code.modify", "deploy.service". */
  action: string;
  /** What the action operates on, e.g. "production.users", "payment/checkout.ts". */
  target?: string;
  environment?: string;
  /** Groups actions into one agent session for replay and reporting. */
  sessionId?: string;
  /** The governance unit, declared in a policy file — repos sharing a name share one scope. */
  projectId?: string;
  /** Whose authority the agent draws on — not who the agent is, which is its credential. */
  principal?: string;
  /** Facts this action relies on, so "may not do" is tellable from "should not know". */
  reads?: readonly string[];
  /** Untrusted sources that influenced the agent's context, reported by the caller. */
  taint?: TaintAssessment;
  /** What the agent read, each block carrying the trust of whoever supplied it. */
  context?: readonly ContextBlock[];
  /** What was actually asked for. Declared by the client; never inferred here. */
  task?: TaskRef;
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
  /** How big the action is; size is often the whole rule. Read by `aboveAmount`. */
  amount?: number;
  /** Directory the agent is working in, e.g. "/srv/checkout". Reported by the caller. */
  workingDirectory?: string;
  /** Source control branch the work sits on, e.g. "main", "release/24.3". */
  branch?: string;
  /** LOCAL ONLY: the raw payload. The SDK strips it; `signals` travel instead. */
  arguments?: Record<string, string>;
  /** What the local gate found. Testimony: it may escalate, never loosen. */
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
  /** Whose authority the agent drew on. Audited: "who asked for this" is the first question. */
  principal?: string;
  taint?: TaintAssessment;
  model?: string;
  provider?: string;
  dataClassification?: string;
  jurisdiction?: string;
  workingDirectory?: string;
  branch?: string;
  /** What actually happened — in observe mode this is always allow. */
  effect: DecisionEffect;
  /** Mode in force for this environment when the action was decided. */
  enforcementMode?: EnforcementMode;
  /** What enforce would have said, when the mode kept it from being applied. */
  shadowEffect?: DecisionEffect;
  /** The task this action was taken under, so a scope refusal is explicable later. */
  taskId?: string;
  riskLevel: RiskLevel;
  matchedPolicies: string[];
  /**
   * The seam that ruled, when the verdict was not this runtime's own. A local gate
   * refuses in-process so the payload never travels; the record still has to say who
   * decided, or a reader cannot tell a reported verdict from a made one.
   */
  decidedBy?: string;
  /** Content version of the rule set that decided this — see versionPolicySet. */
  policyVersion?: string;
  /** Names of advisors that escalated or flagged this action. */
  advisories: string[];
  /** Who was asked, recorded because today's rules answer a different question. */
  approvers?: string[];
  reason: string;
  /** Owning org/workspace; unset = single-tenant deployment. */
  orgId?: string;
  /** Only on execution.outcome events; carried verbatim so a decision joins its effect. */
  decisionEventId?: string;
  executionStatus?: ExecutionStatus;
  rolledBack?: boolean;
  /** The compensating action itself failed, so the resulting state is unknown. */
  rollbackFailed?: boolean;
  /** The agent claimed success on something not allowed — its claim, not a measurement. */
  defiedVerdict?: true;
  /** Tamper evidence, set by the audit log at append time (see audit-chain). */
  prevHash?: string;
  hash?: string;
}

export interface AuditQuery {
  sessionId?: string;
  agentId?: string;
  /** One event by id — how a reported outcome is matched to the decision it claims. */
  eventId?: string;
  orgId?: string;
  projectId?: string;
  from?: string;
  to?: string;
  /** Most recent N matching events, still returned chronologically. Unset = all. */
  limit?: number;
}
