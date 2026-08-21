import { randomUUID } from 'node:crypto';
import type {
  ActionRequest,
  AgentIdentity,
  Approval,
  ApprovalFlowSummary,
  ApprovalNotifier,
  ApprovalStore,
  AuditLog,
  Consent,
  DecisionEffect,
  Logger,
  RiskLevel,
} from '@memnox/core';
import {
  APPROVAL_STATUS,
  APPROVAL_TTL_MS,
  CONSENT,
  DECISION_EFFECT,
  DECISION_REASON,
  RISK_LEVEL,
  SILENT_LOGGER,
  TAINT_NO_OVERRIDE_ACTIONS,
  applyGrant,
  evaluateConsent,
  isApprovalExpired,
  summarizeApprovalFlow,
} from '@memnox/core';
import { matchesAny } from '@memnox/policy-engine';
import type { AgentRegistry } from './agent-registry';
import { APPROVAL_METRIC_STATE, METRIC, MetricsRegistry } from './metrics';
import { fingerprintRequest } from './token';

export const RESOLVE_OUTCOME = {
  /** Quorum met — the action may now proceed. */
  APPROVED: 'approved',
  /** Grant recorded, but more approvers are still required. */
  PENDING: 'pending',
  DENIED: 'denied',
  ALREADY_RESOLVED: 'already_resolved',
  /** Lapsed before anyone acted — retired rather than resolved. */
  EXPIRED: 'expired',
  NOT_FOUND: 'not_found',
} as const;

export type ResolveOutcome = (typeof RESOLVE_OUTCOME)[keyof typeof RESOLVE_OUTCOME];

export interface ResolveResult {
  outcome: ResolveOutcome;
  approval: Approval | null;
}

export const OVERRIDE_OUTCOME = {
  OVERRIDDEN: 'overridden',
  NOT_FOUND: 'not_found',
  NOT_PENDING: 'not_pending',
  /** Lapsed before the glass was broken — the agent must re-request. */
  EXPIRED: 'expired',
  /** The action class is exempt from break-glass entirely. */
  FORBIDDEN: 'forbidden',
} as const;

export type OverrideOutcome = (typeof OVERRIDE_OUTCOME)[keyof typeof OVERRIDE_OUTCOME];

export interface OverrideResult {
  outcome: OverrideOutcome;
  approval: Approval | null;
}

/** What a presented approval means, with the record it came from. */
export interface ConsentResult {
  consent: Consent;
  approval: Approval | null;
}

export interface ApprovalServiceDeps {
  approvalStore: ApprovalStore;
  auditLog: AuditLog;
  agents: AgentRegistry;
  notifier?: ApprovalNotifier;
  metrics?: MetricsRegistry;
  logger?: Logger;
  /** Open holds one agent may accumulate before further ones are refused. */
  maxPendingPerAgent?: number;
}

export const APPROVAL_CAP_REACHED = 'approval_cap_reached';
/** Beyond this many open holds for one agent, something is wrong with the rules. */
export const DEFAULT_MAX_PENDING_PER_AGENT = 10;

/** Raising, consent, quorum, break-glass. What to do with consent is the gateway's. */
export class ApprovalService {
  private readonly metrics: MetricsRegistry;
  private readonly logger: Logger;

  constructor(private readonly deps: ApprovalServiceDeps) {
    this.metrics = deps.metrics ?? new MetricsRegistry();
    this.logger = deps.logger ?? SILENT_LOGGER;
  }

  findById(id: string): Promise<Approval | null> {
    return this.deps.approvalStore.findById(id);
  }

  /** Lapsed ones are filtered here, not in the stores: an adapter is only storage. */
  async pending(now: Date = new Date()): Promise<Approval[]> {
    const open = await this.deps.approvalStore.listByStatus(APPROVAL_STATUS.PENDING);
    return open.filter((approval) => !isApprovalExpired(approval, now));
  }

  /** Assembled from the four statuses because the store lists by status, not in bulk. */
  async flowSummary(now: Date = new Date()): Promise<ApprovalFlowSummary> {
    const byStatus = await Promise.all(
      Object.values(APPROVAL_STATUS).map((status) =>
        this.deps.approvalStore.listByStatus(status),
      ),
    );
    return summarizeApprovalFlow(byStatus.flat(), now);
  }

  /** Reuses the open approval rather than raising a second, and refuses past the cap. */
  async requestFor(
    agent: AgentIdentity,
    request: ActionRequest,
    approvers: string[],
    minApprovals: number,
  ): Promise<Approval | typeof APPROVAL_CAP_REACHED> {
    const fingerprint = fingerprintFor(agent, request);
    const open = await this.deps.approvalStore.findPendingByFingerprint(fingerprint);
    if (open) {
      if (!isApprovalExpired(open)) return open;
      // Handing back a lapsed hold strands the agent: it can never grant consent,
      // and reusing it means no fresh one is ever raised for anyone to act on.
      await this.retire(open);
    }

    const ceiling = this.deps.maxPendingPerAgent ?? DEFAULT_MAX_PENDING_PER_AGENT;
    const outstanding = (await this.pending()).filter(
      (approval) => approval.agentId === agent.id,
    );
    if (outstanding.length >= ceiling) return APPROVAL_CAP_REACHED;

    const approval: Approval = {
      id: randomUUID(),
      requestFingerprint: fingerprint,
      agentId: agent.id,
      action: request.action,
      target: request.target,
      environment: request.environment,
      // Carried onto the record, not just into the fingerprint: an approver who
      // cannot see the amount is being asked to authorize a number they never read.
      ...(request.amount === undefined ? {} : { amount: request.amount }),
      ...(request.principal === undefined ? {} : { principal: request.principal }),
      approvers: [...new Set(approvers)],
      minApprovals,
      grants: [],
      status: APPROVAL_STATUS.PENDING,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + APPROVAL_TTL_MS).toISOString(),
      ...(agent.orgId ? { orgId: agent.orgId } : {}),
    };
    await this.deps.approvalStore.save(approval);
    this.metrics.increment(METRIC.APPROVALS_TOTAL, {
      state: APPROVAL_METRIC_STATE.PENDING,
    });
    await this.notify(approval);
    return approval;
  }

  /** Spends a grant already given; null when there is none. */
  async claimGrantFor(
    agent: AgentIdentity,
    request: ActionRequest,
  ): Promise<Approval | null> {
    const grant = await this.deps.approvalStore.findGrantedByFingerprint(
      fingerprintFor(agent, request),
    );
    if (!grant) return null;
    return this.consume(grant);
  }

  /** One grant authorizes one action; spending it is what makes that true. */
  async consume(approval: Approval): Promise<Approval> {
    const spent: Approval = { ...approval, consumedAt: new Date().toISOString() };
    await this.deps.approvalStore.save(spent);
    return spent;
  }

  /** A lapsed pending approval is retired here so it can never be mistaken for consent. */
  async consentFor(agent: AgentIdentity, request: ActionRequest): Promise<ConsentResult> {
    const approval = await this.deps.approvalStore.findById(request.approvalId ?? '');
    const consent = evaluateConsent(approval, fingerprintFor(agent, request));

    if (consent === CONSENT.EXPIRED && approval) {
      await this.retire(approval);
      return { consent: CONSENT.NOT_APPLICABLE, approval: null };
    }
    return { consent, approval };
  }

  /** Sweeps a lapsed hold to a terminal status so it can never be acted on again. */
  private async retire(approval: Approval): Promise<Approval> {
    const expired: Approval = { ...approval, status: APPROVAL_STATUS.EXPIRED };
    await this.deps.approvalStore.save(expired);
    this.metrics.increment(METRIC.APPROVALS_TOTAL, {
      state: APPROVAL_METRIC_STATE.LAPSED,
      status: APPROVAL_STATUS.EXPIRED,
    });
    return expired;
  }

  async resolve(
    approvalId: string,
    approved: boolean,
    resolvedBy: string,
  ): Promise<ResolveResult> {
    const approval = await this.deps.approvalStore.findById(approvalId);
    if (!approval) return { outcome: RESOLVE_OUTCOME.NOT_FOUND, approval: null };
    if (approval.status !== APPROVAL_STATUS.PENDING) {
      return { outcome: RESOLVE_OUTCOME.ALREADY_RESOLVED, approval };
    }
    // Approving a lapsed hold would resurrect it: consent reads "approved" and
    // never re-checks the TTL, so the expiry would silently stop meaning anything.
    if (isApprovalExpired(approval)) {
      return { outcome: RESOLVE_OUTCOME.EXPIRED, approval: await this.retire(approval) };
    }
    const at = new Date().toISOString();

    if (!approved) {
      const denied: Approval = {
        ...approval,
        status: APPROVAL_STATUS.DENIED,
        resolvedAt: at,
        resolvedBy,
      };
      await this.deps.approvalStore.save(denied);
      await this.auditResolution(
        denied,
        DECISION_EFFECT.BLOCK,
        `approval denied by ${resolvedBy}`,
      );
      this.countResolved(denied);
      return { outcome: RESOLVE_OUTCOME.DENIED, approval: denied };
    }

    const { approval: granted, satisfied } = applyGrant(approval, resolvedBy, at);
    const updated: Approval = satisfied
      ? { ...granted, status: APPROVAL_STATUS.APPROVED, resolvedAt: at, resolvedBy }
      : granted;
    await this.deps.approvalStore.save(updated);
    await this.auditResolution(
      updated,
      satisfied ? DECISION_EFFECT.ALLOW : DECISION_EFFECT.REQUIRE_APPROVAL,
      satisfied
        ? `approval granted by ${resolvedBy}`
        : `approval granted by ${resolvedBy} — ${updated.grants.length} of ${updated.minApprovals}`,
    );
    if (satisfied) this.countResolved(updated);

    return {
      outcome: satisfied ? RESOLVE_OUTCOME.APPROVED : RESOLVE_OUTCOME.PENDING,
      approval: updated,
    };
  }

  /** Break-glass: an admin approves without the named approvers — audited as critical. */
  async override(
    approvalId: string,
    resolvedBy: string,
    reason: string,
  ): Promise<OverrideResult> {
    const approval = await this.deps.approvalStore.findById(approvalId);
    if (!approval) return { outcome: OVERRIDE_OUTCOME.NOT_FOUND, approval: null };
    if (approval.status !== APPROVAL_STATUS.PENDING) {
      return { outcome: OVERRIDE_OUTCOME.NOT_PENDING, approval };
    }
    // Break-glass grants consent for the request that raised the hold; once that
    // request has lapsed there is nothing left to consent to.
    if (isApprovalExpired(approval)) {
      return { outcome: OVERRIDE_OUTCOME.EXPIRED, approval: await this.retire(approval) };
    }
    // Break-glass skips the named approvers; for irreversible actions there is no skip at all.
    if (matchesAny([...TAINT_NO_OVERRIDE_ACTIONS], approval.action)) {
      await this.auditOverride(
        approval,
        DECISION_EFFECT.BLOCK,
        `${DECISION_REASON.NON_OVERRIDABLE}: break-glass refused for "${approval.action}" by ${resolvedBy}: ${reason}`,
      );
      return { outcome: OVERRIDE_OUTCOME.FORBIDDEN, approval };
    }

    const updated: Approval = {
      ...approval,
      status: APPROVAL_STATUS.APPROVED,
      override: true,
      resolvedAt: new Date().toISOString(),
      resolvedBy,
    };
    await this.deps.approvalStore.save(updated);
    await this.auditOverride(
      approval,
      DECISION_EFFECT.ALLOW,
      `${DECISION_REASON.BREAK_GLASS_OVERRIDE} by ${resolvedBy}: ${reason}`,
    );
    this.countResolved(updated);
    return { outcome: OVERRIDE_OUTCOME.OVERRIDDEN, approval: updated };
  }

  /** Break-glass and its refusal are both security events, both critical. */
  private async auditOverride(
    approval: Approval,
    effect: typeof DECISION_EFFECT.ALLOW | typeof DECISION_EFFECT.BLOCK,
    reason: string,
  ): Promise<void> {
    await this.auditResolution(approval, effect, reason, RISK_LEVEL.CRITICAL);
  }

  /** Only break-glass used to be audited, so an ordinary grant left no trace. */
  private async auditResolution(
    approval: Approval,
    effect: DecisionEffect,
    reason: string,
    riskLevel: RiskLevel = approval.risk ?? RISK_LEVEL.MEDIUM,
  ): Promise<void> {
    const agent = await this.deps.agents.findById(approval.agentId);
    await this.deps.auditLog.append({
      id: randomUUID(),
      occurredAt: new Date().toISOString(),
      agentId: approval.agentId,
      agentName: agent ? agent.name : approval.agentId,
      action: approval.action,
      target: approval.target,
      environment: approval.environment,
      effect,
      riskLevel,
      matchedPolicies: [],
      advisories: [],
      reason,
      orgId: approval.orgId,
    });
  }

  private countResolved(approval: Approval): void {
    this.metrics.increment(METRIC.APPROVALS_TOTAL, {
      state: APPROVAL_METRIC_STATE.RESOLVED,
      status: approval.status,
    });
  }

  /** Notification is best-effort: the audit log is the record, not the message. */
  private async notify(approval: Approval): Promise<void> {
    if (!this.deps.notifier) return;
    try {
      await this.deps.notifier.notify(approval);
    } catch (err) {
      this.logger.warn(`approval notification failed for ${approval.id}: ${String(err)}`);
    }
  }
}

function fingerprintFor(agent: AgentIdentity, request: ActionRequest): string {
  return fingerprintRequest({
    agentId: agent.id,
    action: request.action,
    target: request.target,
    environment: request.environment,
    amount: request.amount,
    principal: request.principal,
  });
}
