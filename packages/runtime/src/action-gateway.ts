import { randomUUID } from 'node:crypto';
import type {
  ActionAdvisor,
  ActionEvent,
  ActionRequest,
  Advisory,
  AgentIdentity,
  AgentKind,
  AgentStatus,
  Approval,
  ApprovalNotifier,
  ApprovalStore,
  AuditChainVerification,
  AuditLog,
  AuditQuery,
  Decision,
  DecisionEffect,
  EnforcementMode,
  EnvironmentModes,
  ExecutionOutcomeReport,
  IdentityStore,
  Logger,
  MatchedPolicy,
  RiskAssessment,
  RiskLevel,
} from '@memnox/core';
import {
  AGENT_STATUS,
  APPROVAL_STATUS,
  APPROVAL_TTL_MS,
  CONSENT,
  DECISION_EFFECT,
  DECISION_REASON,
  EFFECT_PRECEDENCE,
  EMPTY_AGENT_STATS,
  ENFORCEMENT_MODE,
  ENFORCEMENT_REASON,
  applyEnforcementMode,
  resolveEnforcementMode,
  AGENT_ROTATE_ACTION,
  applyGrant,
  DEFAULT_MIN_APPROVALS,
  EXECUTION_OUTCOME_ACTION,
  EXECUTION_STATUS,
  computeTrustScore,
  isApprovalExpired,
  RISK_LEVEL,
  SILENT_LOGGER,
  TAINT_NO_OVERRIDE_ACTIONS,
  UNVERIFIED_EXECUTION_STATUSES,
} from '@memnox/core';
import { LLM_SPEND_ACTION } from '@memnox/risk';
import {
  classifyRisk,
  matchesAny,
  PolicyEngine,
  type Policy,
} from '@memnox/policy-engine';
import type { AgentJwtConfig } from './agent-jwt';
import { AgentRegistry, type AgentRegistration } from './agent-registry';
import {
  APPROVAL_CAP_REACHED,
  ApprovalService,
  type OverrideResult,
  type ResolveResult,
} from './approval-service';
import { APPROVAL_METRIC_STATE, METRIC, MetricsRegistry } from './metrics';
import { fingerprintRequest } from './token';

const UNKNOWN_AGENT_ID = 'unknown';

/**
 * A failed rollback is the worst case: the action ran, could not be verified, and
 * could not be undone, so nobody knows what state the system is in.
 */
function outcomeRiskLevel(report: ExecutionOutcomeReport): RiskLevel {
  if (report.rollbackError) return RISK_LEVEL.CRITICAL;
  if (UNVERIFIED_EXECUTION_STATUSES.includes(report.status)) {
    return report.rolledBack ? RISK_LEVEL.MEDIUM : RISK_LEVEL.HIGH;
  }
  return RISK_LEVEL.LOW;
}

function describeOutcome(report: ExecutionOutcomeReport): string {
  const parts = [`${report.action} ${report.status}`];
  if (report.failedCondition) parts.push(`failed: ${report.failedCondition}`);
  if (report.rollbackError) parts.push(`rollback FAILED: ${report.rollbackError}`);
  else if (report.rolledBack) parts.push('rolled back');
  else if (report.status !== EXECUTION_STATUS.SUCCEEDED) parts.push('not rolled back');
  return parts.join(' — ');
}

/** The one advisory class an approval cannot satisfy. */
function nonOverridableBlock(advisories: Advisory[]): Advisory | undefined {
  return advisories.find(
    (advisory) =>
      advisory.nonOverridable === true && advisory.escalateTo === DECISION_EFFECT.BLOCK,
  );
}

export interface ActionGatewayDeps {
  identityStore: IdentityStore;
  auditLog: AuditLog;
  approvalStore: ApprovalStore;
  policyEngine: PolicyEngine;
  advisors?: ActionAdvisor[];
  notifier?: ApprovalNotifier;
  logger?: Logger;
  /** Accept HS256 service-account JWTs (sub = agent ID) in addition to bearer tokens. */
  agentJwt?: AgentJwtConfig;
  /** Counters for /v1/metrics; a private registry when the caller supplies none. */
  metrics?: MetricsRegistry;
  /** Per-environment enforcement; unset means every environment is monitored. */
  enforcement?: EnvironmentModes;
  /** Open holds one agent may accumulate before further ones are refused. */
  maxPendingPerAgent?: number;
}

interface Outcome {
  effect: DecisionEffect;
  reason: string;
  matchedPolicies?: MatchedPolicy[];
  advisories?: Advisory[];
  approvalId?: string;
  enforcementMode?: EnforcementMode;
  /** Set when the mode kept a non-allow verdict from being applied. */
  withheldEffect?: DecisionEffect;
}

/**
 * The deterministic decision pipeline: identity → policy → advisors → approval → audit.
 * Every request produces exactly one audited event — allowed or not.
 */
export class ActionGateway {
  private readonly advisors: ActionAdvisor[];
  private readonly logger: Logger;
  private readonly metrics: MetricsRegistry;

  readonly agents: AgentRegistry;
  readonly approvals: ApprovalService;

  constructor(private readonly deps: ActionGatewayDeps) {
    this.advisors = deps.advisors ?? [];
    this.logger = deps.logger ?? SILENT_LOGGER;
    this.metrics = deps.metrics ?? new MetricsRegistry();
    this.agents = new AgentRegistry(deps.identityStore, deps.agentJwt);
    this.approvals = new ApprovalService({
      approvalStore: deps.approvalStore,
      auditLog: deps.auditLog,
      agents: this.agents,
      ...(deps.notifier ? { notifier: deps.notifier } : {}),
      metrics: this.metrics,
      logger: this.logger,
      ...(deps.maxPendingPerAgent === undefined
        ? {}
        : { maxPendingPerAgent: deps.maxPendingPerAgent }),
    });
  }

  registerAgent(
    name: string,
    kind: AgentKind,
    capabilities?: string[],
    orgId?: string,
  ): Promise<AgentRegistration> {
    return this.agents.register(name, kind, capabilities, orgId);
  }

  /** Rotation is audited here because the audit log belongs to the gateway. */
  async rotateAgentToken(agentId: string): Promise<AgentRegistration | null> {
    const rotated = await this.agents.rotate(agentId);
    if (!rotated) return null;

    await this.appendEvent({
      id: randomUUID(),
      occurredAt: new Date().toISOString(),
      agentId: rotated.agent.id,
      agentName: rotated.agent.name,
      action: AGENT_ROTATE_ACTION,
      target: rotated.agent.id,
      effect: DECISION_EFFECT.ALLOW,
      riskLevel: RISK_LEVEL.MEDIUM,
      matchedPolicies: [],
      advisories: [],
      reason: `credential rotated for agent "${rotated.agent.name}"`,
      orgId: rotated.agent.orgId,
    });
    return rotated;
  }

  setAgentStatus(agentId: string, status: AgentStatus): Promise<AgentIdentity | null> {
    return this.agents.setStatus(agentId, status);
  }

  /** The rule set currently in force — read-only, for the policy API. */
  policies(): Policy[] {
    return this.deps.policyEngine.rules();
  }

  /** Swaps the rule set at runtime. The composition root owns engine options. */
  usePolicyEngine(engine: PolicyEngine): void {
    this.deps.policyEngine = engine;
  }

  async authorize(agentToken: string, request: ActionRequest): Promise<Decision> {
    return this.authorizeAgent(await this.resolveAgent(agentToken), request);
  }

  /**
   * Records what an allowed action actually did. This is the caller's testimony,
   * not a verdict — the runtime cannot observe the outside world, so it stores the
   * claim and lets the audit trail show a decision that was never followed up.
   * Returns false when the token does not resolve to an agent.
   */
  async recordOutcome(
    agentToken: string,
    report: ExecutionOutcomeReport,
  ): Promise<boolean> {
    const agent = await this.resolveAgent(agentToken);
    if (!agent) return false;

    await this.appendEvent({
      id: randomUUID(),
      occurredAt: new Date().toISOString(),
      agentId: agent.id,
      agentName: agent.name,
      action: EXECUTION_OUTCOME_ACTION,
      target: report.target ?? report.action,
      environment: report.environment,
      sessionId: report.sessionId,
      effect: DECISION_EFFECT.ALLOW,
      riskLevel: outcomeRiskLevel(report),
      matchedPolicies: [],
      advisories: [],
      reason: describeOutcome(report),
      orgId: agent.orgId,
    });
    return true;
  }

  /**
   * Appends metered LLM usage. Deliberately not policy-evaluated: recording is
   * bookkeeping, and blocking the record once a budget is spent would freeze the
   * ledger so the cap could never fire again.
   */
  async recordSpend(
    agentToken: string,
    tokens: number,
    sessionId: string,
    environment?: string,
  ): Promise<boolean> {
    const agent = await this.resolveAgent(agentToken);
    if (!agent || tokens <= 0) return false;

    await this.appendEvent({
      id: randomUUID(),
      occurredAt: new Date().toISOString(),
      agentId: agent.id,
      agentName: agent.name,
      action: LLM_SPEND_ACTION,
      target: String(tokens),
      environment,
      sessionId,
      effect: DECISION_EFFECT.ALLOW,
      riskLevel: RISK_LEVEL.LOW,
      matchedPolicies: [],
      advisories: [],
      reason: `metered ${tokens} token(s)`,
      orgId: agent.orgId,
    });
    return true;
  }

  /** What the decision would be, without making it — nothing is recorded. */
  async assess(agentToken: string, request: ActionRequest): Promise<RiskAssessment> {
    const agent = await this.resolveAgent(agentToken);
    if (!agent) {
      return {
        effect: DECISION_EFFECT.BLOCK,
        riskLevel: RISK_LEVEL.CRITICAL,
        reason: DECISION_REASON.UNKNOWN_AGENT,
        matchedPolicies: [],
        advisories: [],
        trustScore: 0,
      };
    }

    const riskLevel = classifyRisk(request.action, request.environment);
    const capabilities = agent.capabilities;
    if (
      capabilities !== undefined &&
      capabilities.length > 0 &&
      !matchesAny(capabilities, request.action)
    ) {
      return {
        effect: DECISION_EFFECT.BLOCK,
        riskLevel,
        reason: DECISION_REASON.CAPABILITY,
        matchedPolicies: [],
        advisories: [],
        trustScore: computeTrustScore(agent.stats),
      };
    }

    const evaluation = this.deps.policyEngine.evaluate(request, {
      agentName: agent.name,
      now: new Date(),
    });
    const advisories = await this.collectAdvisories(request, agent);
    const effect = this.combineEffects(evaluation.effect, advisories);
    const escalation = advisories.find((advisory) => advisory.escalateTo === effect);

    return {
      effect,
      riskLevel: evaluation.riskLevel,
      reason:
        effect === evaluation.effect
          ? evaluation.reason
          : escalation === undefined
            ? evaluation.reason
            : escalation.reason,
      matchedPolicies: evaluation.matchedPolicies,
      advisories,
      trustScore: computeTrustScore(agent.stats),
    };
  }

  /** Pipeline entry for already-authenticated identities (e.g. mTLS client certs). */
  async authorizeAgent(
    agent: AgentIdentity | null,
    request: ActionRequest,
  ): Promise<Decision> {
    if (!agent) {
      return this.finalize(null, request, {
        effect: DECISION_EFFECT.BLOCK,
        reason: DECISION_REASON.UNKNOWN_AGENT,
      });
    }
    if (agent.status === AGENT_STATUS.SUSPENDED) {
      return this.finalize(agent, request, {
        effect: DECISION_EFFECT.BLOCK,
        reason: DECISION_REASON.AGENT_SUSPENDED,
      });
    }
    // Capabilities bound the agent before policy — even a granted approval cannot widen them.
    const capabilities = agent.capabilities;
    if (
      capabilities !== undefined &&
      capabilities.length > 0 &&
      !matchesAny(capabilities, request.action)
    ) {
      return this.finalize(agent, request, {
        effect: DECISION_EFFECT.BLOCK,
        reason: DECISION_REASON.CAPABILITY,
      });
    }

    // One advisor pass per request, shared by the approval and policy paths.
    let cachedAdvisories: Advisory[] | null = null;
    const advise = async (): Promise<Advisory[]> => {
      cachedAdvisories ??= await this.collectAdvisories(request, agent);
      return cachedAdvisories;
    };

    // Identity and capability are settled above and are never relaxed by the
    // mode: monitoring a policy is a choice, admitting an unknown caller is not.
    const mode = resolveEnforcementMode(this.deps.enforcement ?? {}, request.environment);
    if (mode === ENFORCEMENT_MODE.OFF) {
      return this.finalize(agent, request, {
        effect: DECISION_EFFECT.ALLOW,
        reason: ENFORCEMENT_REASON.DISABLED,
        enforcementMode: mode,
      });
    }

    if (request.approvalId) {
      const resolved = await this.applyApproval(agent, request, await advise());
      if (resolved) return resolved;
    }

    const evaluation = this.deps.policyEngine.evaluate(request, {
      agentName: agent.name,
      now: new Date(),
    });
    const advisories = await advise();
    const verdict = this.combineEffects(evaluation.effect, advisories);
    const escalation = advisories.find((advisory) => advisory.escalateTo === verdict);
    const verdictReason =
      verdict === evaluation.effect
        ? evaluation.reason
        : escalation === undefined
          ? evaluation.reason
          : escalation.reason;

    const applied = applyEnforcementMode(verdict, mode);
    const effect = applied.effect;
    const reason =
      applied.withheldEffect === undefined
        ? verdictReason
        : `${ENFORCEMENT_REASON.OBSERVED}: ${verdictReason}`;

    if (effect === DECISION_EFFECT.REQUIRE_APPROVAL) {
      const approvers = [
        ...evaluation.matchedPolicies.flatMap((policy) => policy.approvers ?? []),
        ...advisories.flatMap((advisory) => advisory.approvers ?? []),
      ];
      const minApprovals = Math.max(
        DEFAULT_MIN_APPROVALS,
        ...evaluation.matchedPolicies.map(
          (policy) => policy.minApprovals ?? DEFAULT_MIN_APPROVALS,
        ),
      );
      const approval = await this.approvals.requestFor(
        agent,
        request,
        approvers,
        minApprovals,
      );
      // Past the ceiling, block rather than add a hold nobody will read.
      if (approval === APPROVAL_CAP_REACHED) {
        return this.finalize(agent, request, {
          effect: DECISION_EFFECT.BLOCK,
          reason: `${reason} — too many approvals already pending for this agent`,
          matchedPolicies: evaluation.matchedPolicies,
          advisories,
          enforcementMode: mode,
        });
      }
      return this.finalize(agent, request, {
        effect,
        reason: `${DECISION_REASON.APPROVAL_PENDING}: ${reason}`,
        matchedPolicies: evaluation.matchedPolicies,
        advisories,
        approvalId: approval.id,
        enforcementMode: mode,
      });
    }

    return this.finalize(agent, request, {
      effect,
      reason,
      matchedPolicies: evaluation.matchedPolicies,
      advisories,
      enforcementMode: mode,
      ...(applied.withheldEffect === undefined
        ? {}
        : { withheldEffect: applied.withheldEffect }),
    });
  }

  private resolveAgent(token: string): Promise<AgentIdentity | null> {
    return this.agents.resolveByToken(token);
  }

  listAgents(): Promise<AgentIdentity[]> {
    return this.agents.list();
  }

  async recentAuditEvents(limit: number): Promise<ActionEvent[]> {
    return this.deps.auditLog.recent(limit);
  }

  async queryAuditEvents(filter: AuditQuery): Promise<ActionEvent[]> {
    return this.deps.auditLog.query(filter);
  }

  async verifyAuditChain(): Promise<AuditChainVerification> {
    return this.deps.auditLog.verifyChain();
  }

  /** Advisors can only tighten the decision — the most restrictive effect wins. */
  private combineEffects(
    policyEffect: DecisionEffect,
    advisories: Advisory[],
  ): DecisionEffect {
    return advisories.reduce<DecisionEffect>((current, advisory) => {
      if (!advisory.escalateTo) return current;
      return EFFECT_PRECEDENCE[advisory.escalateTo] > EFFECT_PRECEDENCE[current]
        ? advisory.escalateTo
        : current;
    }, policyEffect);
  }

  /** An advisor failure means no escalation — it must never turn into a crash or an allow-nothing. */
  private async collectAdvisories(
    request: ActionRequest,
    agent: AgentIdentity,
  ): Promise<Advisory[]> {
    const advisories: Advisory[] = [];
    for (const advisor of this.advisors) {
      try {
        advisories.push(...(await advisor.advise(request, { agent })));
      } catch (err) {
        this.logger.warn(`advisor "${advisor.name}" failed: ${String(err)}`);
      }
    }
    return advisories;
  }

  /** Turns consent into a decision. Whether consent exists is the service's call. */
  private async applyApproval(
    agent: AgentIdentity,
    request: ActionRequest,
    advisories: Advisory[],
  ): Promise<Decision | null> {
    const { consent, approval } = await this.approvals.consentFor(agent, request);
    if (!approval) return null;

    if (consent === CONSENT.GRANTED) {
      // Consent is not a bypass: a non-overridable block outranks any approval.
      const veto = nonOverridableBlock(advisories);
      return this.finalize(agent, request, {
        effect: veto ? DECISION_EFFECT.BLOCK : DECISION_EFFECT.ALLOW,
        reason: veto
          ? `${DECISION_REASON.NON_OVERRIDABLE}: ${veto.reason}`
          : `${DECISION_REASON.APPROVAL_GRANTED} by ${approval.resolvedBy}`,
        advisories,
        approvalId: approval.id,
      });
    }
    if (consent === CONSENT.DENIED) {
      return this.finalize(agent, request, {
        effect: DECISION_EFFECT.BLOCK,
        reason: `approval denied by ${approval.resolvedBy}`,
        advisories,
        approvalId: approval.id,
      });
    }
    return null;
  }

  private async finalize(
    agent: AgentIdentity | null,
    request: ActionRequest,
    outcome: Outcome,
  ): Promise<Decision> {
    // Unauthenticated attempts are always critical — someone is probing with bad credentials.
    const riskLevel = agent
      ? classifyRisk(request.action, request.environment)
      : RISK_LEVEL.CRITICAL;
    const advisories = outcome.advisories ?? [];

    const decision: Decision = {
      eventId: randomUUID(),
      effect: outcome.effect,
      riskLevel,
      reason: outcome.reason,
      matchedPolicies: outcome.matchedPolicies ?? [],
      advisories,
      approvalId: outcome.approvalId,
      withheldEffect: outcome.withheldEffect,
    };

    await this.appendEvent({
      id: decision.eventId,
      occurredAt: new Date().toISOString(),
      agentId: agent === null ? UNKNOWN_AGENT_ID : agent.id,
      agentName: agent === null ? UNKNOWN_AGENT_ID : agent.name,
      action: request.action,
      target: request.target,
      environment: request.environment,
      sessionId: request.sessionId,
      taint: request.taint,
      model: request.model,
      provider: request.provider,
      dataClassification: request.dataClassification,
      jurisdiction: request.jurisdiction,
      effect: outcome.effect,
      enforcementMode: outcome.enforcementMode,
      withheldEffect: outcome.withheldEffect,
      riskLevel,
      matchedPolicies: (outcome.matchedPolicies ?? []).map((policy) => policy.name),
      policyVersion: this.deps.policyEngine.version,
      advisories: advisories.flatMap((advisory) =>
        advisory.signals.map((signal) => `${advisory.source}:${signal}`),
      ),
      reason: outcome.reason,
      orgId: agent === null ? undefined : agent.orgId,
    });

    this.metrics.increment(METRIC.ACTIONS_TOTAL, {
      effect: outcome.effect,
      risk: riskLevel,
    });
    if (agent) await this.recordStats(agent, outcome.effect);
    return decision;
  }

  /** Counts the failure and still rethrows: an unaudited action must not look allowed. */
  private async appendEvent(event: ActionEvent): Promise<void> {
    try {
      await this.deps.auditLog.append(event);
    } catch (err) {
      this.metrics.increment(METRIC.AUDIT_APPEND_FAILURES_TOTAL);
      this.logger.error(`audit append failed for ${event.id}: ${String(err)}`);
      throw err;
    }
  }

  private async recordStats(agent: AgentIdentity, effect: DecisionEffect): Promise<void> {
    const stats = { ...agent.stats };
    if (effect === DECISION_EFFECT.ALLOW) stats.allowed += 1;
    if (effect === DECISION_EFFECT.BLOCK) stats.blocked += 1;
    if (effect === DECISION_EFFECT.REQUIRE_APPROVAL) stats.approvalsRequested += 1;
    await this.agents.recordDecisionStats(agent, stats);
  }
}
