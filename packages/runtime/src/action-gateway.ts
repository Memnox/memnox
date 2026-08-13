import { randomUUID } from 'node:crypto';
import type {
  ActionAdvisor,
  ActionBriefing,
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
  ExecutionMeasurement,
  ExecutionOutcomeReport,
  FixedWindowRateLimiter,
  IdentityStore,
  Logger,
  MatchedPolicy,
  RiskAssessment,
  RiskLevel,
} from '@memnox/core';
import {
  AGENT_STATUS,
  buildActionBriefing,
  APPROVAL_STATUS,
  APPROVAL_TTL_MS,
  CONSENT,
  DECISION_EFFECT,
  DECISION_REASON,
  EFFECT_PRECEDENCE,
  EMPTY_AGENT_STATS,
  ENFORCEMENT_MODE,
  ENFORCEMENT_REASON,
  ENFORCEMENT_SET_ACTION,
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

/** "default=monitor, production=enforce", or "unset" when nothing is declared. */
function describeModes(modes: EnvironmentModes): string {
  const parts = [
    ...(modes.default === undefined ? [] : [`default=${modes.default}`]),
    ...Object.entries(modes.environments ?? {}).map(([name, mode]) => `${name}=${mode}`),
  ];
  return parts.length === 0 ? 'unset' : parts.join(', ');
}

/** True when any environment ends up applying less than it did. */
function weakens(before: EnvironmentModes, after: EnvironmentModes): boolean {
  const strength: Record<EnforcementMode, number> = {
    [ENFORCEMENT_MODE.OFF]: 0,
    [ENFORCEMENT_MODE.MONITOR]: 1,
    [ENFORCEMENT_MODE.ENFORCE]: 2,
  };
  const names = new Set([
    ...Object.keys(before.environments ?? {}),
    ...Object.keys(after.environments ?? {}),
  ]);
  for (const name of names) {
    const was = resolveEnforcementMode(before, name);
    const now = resolveEnforcementMode(after, name);
    if (strength[now] < strength[was]) return true;
  }
  return (
    strength[resolveEnforcementMode(after, undefined)] <
    strength[resolveEnforcementMode(before, undefined)]
  );
}

const UNKNOWN_AGENT_ID = 'unknown';
const RATE_LIMIT_RULE_PREFIX = 'rule';
const LOCAL_SIGNAL_SOURCE = 'local';

/** The stricter of two withheld verdicts, or whichever one exists. */
function stricter(
  left: DecisionEffect | undefined,
  right: DecisionEffect | undefined,
): DecisionEffect | undefined {
  if (left === undefined) return right;
  if (right === undefined) return left;
  return EFFECT_PRECEDENCE[right] > EFFECT_PRECEDENCE[left] ? right : left;
}

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
  // The caller's numbers ride along in the reason: they are testimony about the
  // outcome, not a field the runtime derived or could verify.
  if (report.measurements !== undefined && report.measurements.length > 0) {
    parts.push(report.measurements.map(describeMeasurement).join(', '));
  }
  return parts.join(' — ');
}

function describeMeasurement(measurement: ExecutionMeasurement): string {
  const unit = measurement.unit === undefined ? '' : measurement.unit;
  return `${measurement.name}=${measurement.value}${unit}`;
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
  /**
   * Counts per-rule rate limits. Shared with the HTTP limiter so one Redis-backed
   * counter serves every process; without it, `rateLimit` rules are inert.
   */
  rateLimiter?: FixedWindowRateLimiter;
}

interface Outcome {
  effect: DecisionEffect;
  reason: string;
  matchedPolicies?: MatchedPolicy[];
  advisories?: Advisory[];
  approvalId?: string;
  /** Who the action was routed to, when it was routed to anybody. */
  approvers?: string[];
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

  /** The modes in force, per environment. Read-only, for the management API. */
  enforcement(): EnvironmentModes {
    return this.deps.enforcement ?? {};
  }

  /**
   * Swaps the modes at runtime. Resolved per request, so this takes effect on
   * the next decision without a restart or an engine rebuild.
   *
   * Audited: weakening governance is the most consequential thing anybody can
   * do here, and a chain that records every blocked action but not the moment
   * blocking was turned off proves the wrong thing.
   */
  async useEnforcement(modes: EnvironmentModes): Promise<void> {
    const before = this.deps.enforcement ?? {};
    this.deps.enforcement = modes;

    await this.appendEvent({
      id: randomUUID(),
      occurredAt: new Date().toISOString(),
      agentId: UNKNOWN_AGENT_ID,
      agentName: 'management',
      action: ENFORCEMENT_SET_ACTION,
      target: describeModes(modes),
      effect: DECISION_EFFECT.ALLOW,
      riskLevel: weakens(before, modes) ? RISK_LEVEL.HIGH : RISK_LEVEL.MEDIUM,
      matchedPolicies: [],
      advisories: [],
      reason: `enforcement changed from ${describeModes(before)} to ${describeModes(modes)}`,
    });
  }

  /** Pipeline entry for a bearer token — resolves the agent, then runs the same path. */
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
      decisionEventId: report.decisionEventId,
      executionStatus: report.status,
      rolledBack: report.rolledBack,
      rollbackFailed: report.rollbackError !== undefined,
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

  /**
   * What governs this action, asked before attempting it. Same pipeline as
   * `assess`, rendered as the constraints themselves rather than a verdict — so
   * an agent can read the rules up front instead of discovering them by refusal.
   */
  async brief(agentToken: string, request: ActionRequest): Promise<ActionBriefing> {
    return buildActionBriefing(request, await this.assess(agentToken, request));
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

    const limited = await this.applyRateLimits(
      agent,
      evaluation.matchedPolicies,
      verdict,
      verdictReason,
    );
    const applied = applyEnforcementMode(limited.effect, mode);
    const effect = applied.effect;
    const reason =
      applied.withheldEffect === undefined
        ? limited.reason
        : `${ENFORCEMENT_REASON.OBSERVED}: ${limited.reason}`;
    // Two things can withhold a verdict — the environment's mode and a rule of
    // its own in monitor mode — and the audit should name the stricter of them.
    const withheldEffect = stricter(applied.withheldEffect, evaluation.withheldEffect);

    if (effect === DECISION_EFFECT.REQUIRE_APPROVAL) {
      // Claimed only here, so the extra lookup stays off the allow path. No veto
      // check is needed: a non-overridable advisory escalates to block, and
      // combineEffects would have made that the verdict instead of this branch.
      const granted = await this.approvals.claimGrantFor(agent, request);
      if (granted) {
        return this.finalize(agent, request, {
          effect: DECISION_EFFECT.ALLOW,
          reason: `${DECISION_REASON.APPROVAL_GRANTED} by ${granted.resolvedBy}`,
          matchedPolicies: evaluation.matchedPolicies,
          advisories,
          approvalId: granted.id,
          enforcementMode: mode,
        });
      }

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
        approvers,
        enforcementMode: mode,
      });
    }

    return this.finalize(agent, request, {
      effect,
      reason,
      matchedPolicies: evaluation.matchedPolicies,
      advisories,
      enforcementMode: mode,
      ...(withheldEffect === undefined ? {} : { withheldEffect }),
    });
  }

  /**
   * A ceiling on how often a rule may fire. Only an action that is actually
   * proceeding consumes a slot — a blocked one never happened, and counting it
   * would let refused calls exhaust the budget of the calls that succeed.
   *
   * A limiter that cannot answer does not block: the counter is a budget, not
   * an identity check, and an unreachable Redis must not stop every agent.
   */
  private async applyRateLimits(
    agent: AgentIdentity,
    matched: MatchedPolicy[],
    verdict: DecisionEffect,
    verdictReason: string,
  ): Promise<{ effect: DecisionEffect; reason: string }> {
    const unchanged = { effect: verdict, reason: verdictReason };
    const limiter = this.deps.rateLimiter;
    if (limiter === undefined) return unchanged;
    if (EFFECT_PRECEDENCE[verdict] > EFFECT_PRECEDENCE[DECISION_EFFECT.REDACT]) {
      return unchanged;
    }

    for (const policy of matched) {
      const spec = policy.rateLimit;
      if (spec === undefined || policy.monitored === true) continue;
      try {
        const allowed = await limiter.allow(
          `${RATE_LIMIT_RULE_PREFIX}:${policy.name}:${agent.id}`,
          spec.max,
          spec.windowSeconds,
        );
        if (allowed) continue;
        return {
          effect: DECISION_EFFECT.BLOCK,
          reason: `${DECISION_REASON.RATE_LIMIT}: "${policy.name}" allows ${spec.max} per ${spec.windowSeconds}s`,
        };
      } catch (err) {
        this.logger.warn(`rate limit check failed for "${policy.name}": ${String(err)}`);
      }
    }
    return unchanged;
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
      // Spent either way — a vetoed grant must not stay claimable for a later try.
      await this.approvals.consume(approval);
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
      projectId: request.projectId,
      principal: request.principal,
      taint: request.taint,
      model: request.model,
      provider: request.provider,
      dataClassification: request.dataClassification,
      jurisdiction: request.jurisdiction,
      workingDirectory: request.workingDirectory,
      branch: request.branch,
      effect: outcome.effect,
      enforcementMode: outcome.enforcementMode,
      withheldEffect: outcome.withheldEffect,
      riskLevel,
      matchedPolicies: (outcome.matchedPolicies ?? []).map((policy) => policy.name),
      policyVersion: this.deps.policyEngine.version,
      advisories: [
        ...advisories.flatMap((advisory) =>
          advisory.signals.map((signal) => `${advisory.source}:${signal}`),
        ),
        // What the caller's own gate found. Kept apart by prefix: it is testimony
        // about a payload this process never saw, not a finding it made.
        ...(request.signals ?? []).map((signal) => `${LOCAL_SIGNAL_SOURCE}:${signal}`),
      ],
      reason: outcome.reason,
      ...(outcome.approvers === undefined || outcome.approvers.length === 0
        ? {}
        : { approvers: outcome.approvers }),
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
    // A redacted call did run, so it counts as allowed — masked, not refused.
    if (effect === DECISION_EFFECT.ALLOW || effect === DECISION_EFFECT.REDACT) {
      stats.allowed += 1;
    }
    if (effect === DECISION_EFFECT.BLOCK) stats.blocked += 1;
    if (effect === DECISION_EFFECT.REQUIRE_APPROVAL) stats.approvalsRequested += 1;
    await this.agents.recordDecisionStats(agent, stats);
  }
}
