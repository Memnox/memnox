import type {
  ActionEvent,
  ActionRequest,
  Approval,
  AuditChainVerification,
  AuditQuery,
  ComplianceReport,
  Decision,
  ExecutionOutcomeReport,
  RiskAssessment,
} from '@memnox/core';
import { DECISION_EFFECT } from '@memnox/core';
import { POLICY_DOCUMENT_VERSION, type Policy } from '@memnox/policy-engine';
import { ActionBlockedError, ApprovalRequiredError, MemnoxApiError } from './errors';
import type { PolicyApplyResult, PolicySetView } from './runtime-api';
import {
  runGuarded,
  toOutcomeReport,
  type ExecutionOutcome,
  type GuardedExecution,
} from './reliability-gate';

export interface PolicyHistoryEntry {
  version: string;
  publishedAt: string;
  publishedBy?: string;
  /** Set when this entry was produced by a rollback rather than a fresh publish. */
  restoredFrom?: string;
}

export interface PolicyValidation {
  valid: boolean;
  version?: string;
  errors?: string[];
}

export interface PolicySimulation {
  sampled: number;
  total: number;
  unchanged: number;
  changes: Array<{
    case: { action: string; target?: string; environment?: string; agentName?: string };
    before: string;
    after: string;
    stricter: boolean;
    matchedPolicies: string[];
  }>;
  candidateTotals: Record<string, number>;
}

export interface PolicyRollbackResult {
  rolledBack: boolean;
  restoredFrom?: string;
  version?: string;
  error?: string;
}

export interface DecisionRecordPayload {
  title: string;
  statement: string;
  owner: string;
  actions: string[];
  targets?: string[];
  environments?: string[];
  enforcement?: string;
  reversibilityCost?: string;
  sourceType?: string;
  sourceRef?: string;
  reviewAfter?: string;
  /** ID of an existing decision this one replaces. */
  supersedes?: string;
}

export interface DecisionRecordResponse extends DecisionRecordPayload {
  id: string;
  decidedAt: string;
  enforcement: string;
  status?: string;
  supersededById?: string;
}

export interface DecisionHealthResponse {
  score: number;
  activeDecisions: number;
  stale: number;
  frequentlyViolated: number;
  neverReferenced: number;
  entries: Array<{
    id: string;
    title: string;
    violations: number;
    stale: boolean;
    neverReferenced: boolean;
    dueForReview: boolean;
  }>;
}

export interface AgentSummary {
  id: string;
  name: string;
  kind: string;
  status: string;
  trustScore: number;
  stats: { allowed: number; blocked: number; approvalsRequested: number };
  capabilities?: string[];
}

export interface MemnoxClientOptions {
  baseUrl: string;
  /** Agent token for action checks. */
  token?: string;
  /** Admin token for management routes (agents, approvals, audit). */
  adminToken?: string;
  /** Notified when an outcome report cannot be delivered; the SDK has no logger of its own. */
  onReportFailure?: (report: ExecutionOutcomeReport, error: unknown) => void;
  /** HTTP transport override for proxies, custom agents, and tests. Defaults to global fetch. */
  fetch?: HttpTransport;
}

export type HttpTransport = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string },
) => Promise<Response>;

interface AgentRegistrationResponse {
  agent: { id: string; name: string };
  token: string;
}

export class MemnoxClient {
  constructor(private readonly options: MemnoxClientOptions) {}

  /** Ask the runtime for a decision. Never throws on block — inspect the effect. */
  async check(request: ActionRequest): Promise<Decision> {
    return this.request<Decision>(
      'POST',
      '/v1/actions/check',
      request,
      this.options.token,
    );
  }

  /**
   * Run `execute` only if the runtime allows the action.
   * Throws ActionBlockedError or ApprovalRequiredError otherwise.
   */
  async guard<T>(request: ActionRequest, execute: () => Promise<T>): Promise<T> {
    const decision = await this.check(request);
    if (decision.effect === DECISION_EFFECT.BLOCK) throw new ActionBlockedError(decision);
    if (decision.effect === DECISION_EFFECT.REQUIRE_APPROVAL) {
      throw new ApprovalRequiredError(decision);
    }
    return execute();
  }

  /**
   * guard() plus verification: checks the action, runs it only if allowed, verifies
   * its postconditions, rolls back when they fail, and reports the outcome so the
   * audit log records what happened rather than only what was permitted.
   *
   * Throws on block/approval exactly like guard(); otherwise always returns an
   * outcome — inspect `status` to see whether the work actually held.
   */
  async guardVerified<T>(
    request: ActionRequest,
    plan: GuardedExecution<T>,
  ): Promise<ExecutionOutcome<T>> {
    const decision = await this.check(request);
    if (decision.effect === DECISION_EFFECT.BLOCK) throw new ActionBlockedError(decision);
    if (decision.effect === DECISION_EFFECT.REQUIRE_APPROVAL) {
      throw new ApprovalRequiredError(decision);
    }

    const outcome = await runGuarded(plan);
    await this.reportOutcome(toOutcomeReport(decision, request, outcome));
    return outcome;
  }

  /**
   * Records an execution outcome. Returns false instead of throwing when the
   * report cannot be delivered — a reporting failure must not turn work that
   * already succeeded into an exception. Callers that need to know can check it.
   */
  async reportOutcome(report: ExecutionOutcomeReport): Promise<boolean> {
    try {
      await this.request<{ recorded: boolean }>(
        'POST',
        '/v1/actions/outcome',
        report,
        this.options.token,
      );
      return true;
    } catch (error) {
      if (this.options.onReportFailure) this.options.onReportFailure(report, error);
      return false;
    }
  }

  /** Ask what a decision would be without making it — nothing is audited. */
  async evaluateRisk(request: ActionRequest): Promise<RiskAssessment> {
    return this.request<RiskAssessment>(
      'POST',
      '/v1/evaluate-risk',
      request,
      this.options.token,
    );
  }

  /** Issues a fresh token and retires the old one. Shown once, like registration. */
  async rotateAgent(agentId: string): Promise<AgentRegistrationResponse> {
    return this.request<AgentRegistrationResponse>(
      'POST',
      `/v1/agents/${agentId}/rotate`,
      undefined,
      this.options.adminToken,
    );
  }

  async registerAgent(
    name: string,
    kind: string,
    capabilities?: string[],
  ): Promise<AgentRegistrationResponse> {
    return this.request<AgentRegistrationResponse>(
      'POST',
      '/v1/agents',
      { name, kind, capabilities },
      this.options.adminToken,
    );
  }

  async recentAudit(limit?: number): Promise<ActionEvent[]> {
    const query = limit ? `?limit=${limit}` : '';
    return this.request<ActionEvent[]>(
      'GET',
      `/v1/audit${query}`,
      undefined,
      this.options.adminToken,
    );
  }

  async queryAudit(filter: AuditQuery): Promise<ActionEvent[]> {
    const query = new URLSearchParams();
    if (filter.sessionId) query.set('session', filter.sessionId);
    if (filter.agentId) query.set('agent', filter.agentId);
    if (filter.orgId) query.set('org', filter.orgId);
    if (filter.from) query.set('from', filter.from);
    if (filter.to) query.set('to', filter.to);
    if (filter.limit !== undefined) query.set('limit', String(filter.limit));
    return this.request<ActionEvent[]>(
      'GET',
      `/v1/audit?${query.toString()}`,
      undefined,
      this.options.adminToken,
    );
  }

  /** Walks the audit hash chain server-side and reports the first broken link. */
  async verifyAudit(): Promise<AuditChainVerification> {
    return this.request<AuditChainVerification>(
      'GET',
      '/v1/audit/verify',
      undefined,
      this.options.adminToken,
    );
  }

  /** The rule set currently in force, with its content version. */
  async policies(): Promise<PolicySetView> {
    return this.request<PolicySetView>(
      'GET',
      '/v1/policies',
      undefined,
      this.options.adminToken,
    );
  }

  /** Replaces the runtime's rule set. The runtime persists it before switching. */
  async applyPolicies(policies: readonly Policy[]): Promise<PolicyApplyResult> {
    return this.request<PolicyApplyResult>(
      'PUT',
      '/v1/policies',
      { version: POLICY_DOCUMENT_VERSION, policies },
      this.options.adminToken,
    );
  }

  /** Publish history, newest first. The rules themselves stay on /v1/policies. */
  async policyHistory(): Promise<PolicyHistoryEntry[]> {
    return this.request<PolicyHistoryEntry[]>(
      'GET',
      '/v1/policies/history',
      undefined,
      this.options.adminToken,
    );
  }

  /** Checks a rule set without publishing it. Never mutates the running runtime. */
  async validatePolicies(policies: readonly Policy[]): Promise<PolicyValidation> {
    return this.request<PolicyValidation>(
      'POST',
      '/v1/policies/validate',
      { version: POLICY_DOCUMENT_VERSION, policies },
      this.options.adminToken,
    );
  }

  /** What a candidate rule set would have decided differently over real history. */
  async simulatePolicies(policies: readonly Policy[]): Promise<PolicySimulation> {
    return this.request<PolicySimulation>(
      'POST',
      '/v1/policies/simulate',
      { version: POLICY_DOCUMENT_VERSION, policies },
      this.options.adminToken,
    );
  }

  /** Restores an earlier version, recorded as a new entry rather than a rewind. */
  async rollbackPolicies(version: string): Promise<PolicyRollbackResult> {
    return this.request<PolicyRollbackResult>(
      'POST',
      `/v1/policies/rollback/${encodeURIComponent(version)}`,
      undefined,
      this.options.adminToken,
    );
  }

  /** Keyword search over decision memory. */
  async searchDecisions(query: string): Promise<DecisionRecordResponse[]> {
    return this.request<DecisionRecordResponse[]>(
      'GET',
      `/v1/memory/decisions/search?q=${encodeURIComponent(query)}`,
      undefined,
      this.options.adminToken,
    );
  }

  /** Hybrid keyword + semantic search, when the runtime has an embedding key. */
  async searchMemory(query: string, limit?: number): Promise<DecisionRecordResponse[]> {
    return this.request<DecisionRecordResponse[]>(
      'POST',
      '/v1/memory/search',
      { query, ...(limit === undefined ? {} : { limit }) },
      this.options.adminToken,
    );
  }

  async complianceReport(period: {
    from?: string;
    to?: string;
  }): Promise<ComplianceReport> {
    const query = new URLSearchParams();
    if (period.from) query.set('from', period.from);
    if (period.to) query.set('to', period.to);
    return this.request<ComplianceReport>(
      'GET',
      `/v1/reports/compliance?${query.toString()}`,
      undefined,
      this.options.adminToken,
    );
  }

  async listAgents(): Promise<AgentSummary[]> {
    return this.request<AgentSummary[]>(
      'GET',
      '/v1/agents',
      undefined,
      this.options.adminToken,
    );
  }

  async setAgentStatus(agentId: string, status: string): Promise<AgentSummary> {
    return this.request<AgentSummary>(
      'POST',
      `/v1/agents/${agentId}/status`,
      { status },
      this.options.adminToken,
    );
  }

  async addDecision(payload: DecisionRecordPayload): Promise<DecisionRecordResponse> {
    return this.request<DecisionRecordResponse>(
      'POST',
      '/v1/memory/decisions',
      payload,
      this.options.adminToken,
    );
  }

  async listDecisions(): Promise<DecisionRecordResponse[]> {
    return this.request<DecisionRecordResponse[]>(
      'GET',
      '/v1/memory/decisions',
      undefined,
      this.options.adminToken,
    );
  }

  async setDecisionStatus(id: string, status: string): Promise<DecisionRecordResponse> {
    return this.request<DecisionRecordResponse>(
      'POST',
      `/v1/memory/decisions/${id}/status`,
      { status },
      this.options.adminToken,
    );
  }

  /** Prompt-injectable markdown digest of the active constraints. */
  async decisionDigest(): Promise<string> {
    const response = await this.request<{ digest: string }>(
      'GET',
      '/v1/memory/digest',
      undefined,
      this.options.adminToken,
    );
    return response.digest;
  }

  async decisionHealth(): Promise<DecisionHealthResponse> {
    return this.request<DecisionHealthResponse>(
      'GET',
      '/v1/memory/health',
      undefined,
      this.options.adminToken,
    );
  }

  async removeDecision(id: string): Promise<void> {
    await this.request<{ removed: boolean }>(
      'DELETE',
      `/v1/memory/decisions/${id}`,
      undefined,
      this.options.adminToken,
    );
  }

  /**
   * Poll one approval. An agent token may read only the approval it raised;
   * an admin token may read any. Lets a blocked agent wait and retry.
   */
  async approvalStatus(approvalId: string): Promise<Approval> {
    return this.request<Approval>(
      'GET',
      `/v1/approvals/${approvalId}`,
      undefined,
      this.options.adminToken ?? this.options.token,
    );
  }

  async pendingApprovals(): Promise<Approval[]> {
    return this.request<Approval[]>(
      'GET',
      '/v1/approvals',
      undefined,
      this.options.adminToken,
    );
  }

  async resolveApproval(
    approvalId: string,
    approved: boolean,
    resolvedBy: string,
  ): Promise<Approval> {
    return this.request<Approval>(
      'POST',
      `/v1/approvals/${approvalId}`,
      { approved, resolvedBy },
      this.options.adminToken,
    );
  }

  /** Break-glass: admin-only, requires a reason, audited as critical. */
  async overrideApproval(approvalId: string, reason: string): Promise<Approval> {
    return this.request<Approval>(
      'POST',
      `/v1/approvals/${approvalId}/override`,
      { reason },
      this.options.adminToken,
    );
  }

  /**
   * Audit evidence as CSV. Returns text rather than JSON, so it bypasses the
   * shared request helper's parse step.
   */
  async exportAuditCsv(period: { from?: string; to?: string } = {}): Promise<string> {
    const query = new URLSearchParams();
    if (period.from) query.set('from', period.from);
    if (period.to) query.set('to', period.to);
    const suffix = query.toString() ? `?${query.toString()}` : '';
    const headers: Record<string, string> = {};
    if (this.options.adminToken) {
      headers['authorization'] = `Bearer ${this.options.adminToken}`;
    }
    const send = this.options.fetch ?? fetch;
    const response = await send(`${this.options.baseUrl}/v1/audit/export.csv${suffix}`, {
      method: 'GET',
      headers,
    });
    if (!response.ok) {
      throw new MemnoxApiError(
        response.status,
        `audit export failed: ${response.status}`,
      );
    }
    return response.text();
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    bearer?: string,
  ): Promise<T> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (bearer) headers['authorization'] = `Bearer ${bearer}`;

    const send = this.options.fetch ?? fetch;
    const response = await send(`${this.options.baseUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new MemnoxApiError(response.status, `${method} ${path} failed: ${detail}`);
    }
    return (await response.json()) as T;
  }
}
