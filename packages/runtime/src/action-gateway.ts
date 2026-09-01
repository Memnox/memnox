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
  Alternative,
  ExplanationStore,
  MatchedPolicy,
  RiskAssessment,
  RiskLevel,
  RuleRef,
  ScopeComparison,
  ScopeSubject,
  Task,
  TaskStore,
} from '@memnox/core';
import {
  digest,
  FRAME_KIND,
  keepFrame,
  type Frame,
  type FrameStore,
} from '@memnox/ledger';
import {
  compileStateFacts,
  matchesScope as stateApplies,
  stateVersion,
} from '@memnox/org-graph';
import type { StateFactStore } from './stores/json-file-state-store';
import {
  AGENT_STATUS,
  buildActionBriefing,
  buildExplanation,
  compareDeclaredScope,
  APPROVAL_STATUS,
  APPROVAL_TTL_MS,
  CONSENT,
  DECISION_EFFECT,
  DECISION_REASON,
  EFFECT_PRECEDENCE,
  EMPTY_AGENT_STATS,
  ENFORCEMENT_MODE,
  normalizeActionRequest,
  ENFORCEMENT_REASON,
  ENFORCEMENT_SET_ACTION,
  applyEnforcementMode,
  resolveEnforcementMode,
  DEFAULT_ENFORCEMENT_MODE,
  MODE_STRENGTH,
  AGENT_ROTATE_ACTION,
  applyGrant,
  DEFAULT_MIN_APPROVALS,
  EXECUTION_OUTCOME_ACTION,
  EXECUTION_STATUS,
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
  const strength = MODE_STRENGTH;
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

/** What became of a reported outcome. The caller maps these onto status codes. */
export const OUTCOME_UNAUTHORIZED = 'unauthorized';
export const OUTCOME_UNKNOWN_DECISION = 'unknown_decision';
export const OUTCOME_RECORDED = 'recorded';
/** Recorded, and the agent claimed success on something that was not allowed. */
export const OUTCOME_DEFIED = 'defied';

export type OutcomeRecording =
  | typeof OUTCOME_UNAUTHORIZED
  | typeof OUTCOME_UNKNOWN_DECISION
  | typeof OUTCOME_RECORDED
  | typeof OUTCOME_DEFIED;

/** The stricter of two withheld verdicts, or whichever one exists. */
function stricter(
  left: DecisionEffect | undefined,
  right: DecisionEffect | undefined,
): DecisionEffect | undefined {
  if (left === undefined) return right;
  if (right === undefined) return left;
  return EFFECT_PRECEDENCE[right] > EFFECT_PRECEDENCE[left] ? right : left;
}

/** A failed rollback is the worst case: nobody knows what state the system is in. */
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
      advisory.nonOverridable === true &&
      advisory.escalateTo === DECISION_EFFECT.WITHHOLD,
  );
}

/** What a seam can say about a verdict it reached. Never the payload behind it. */
export interface SeamVerdictReport {
  action: string;
  target?: string;
  effect: DecisionEffect;
  reason: string;
  /** The rule that matched, so the explanation cites rather than asserts. */
  rule?: string;
  alternative?: Alternative;
  sessionId?: string;
  /** Which seam ruled, so coverage and drift can tell them apart. */
  seam: string;
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
  /** Per-environment enforcement; unset means every environment is observed. */
  enforcement?: EnvironmentModes;
  /** Open holds one agent may accumulate before further ones are refused. */
  maxPendingPerAgent?: number;
  /** Shared with the HTTP limiter; without it `rateLimit` rules are inert. */
  rateLimiter?: FixedWindowRateLimiter;
  /** Keeps the explanation built from each match, so `why` is a read and not a retelling. */
  explanations?: ExplanationStore;
  /** Declared tasks, so an out-of-scope request is a fact a rule can match on. */
  tasks?: TaskStore;
  /** The flight recorder. Full fidelity on anything not simply allowed, sampled otherwise. */
  frames?: FrameStore;
  /** The company's current condition, read as a policy input rather than queried. */
  state?: StateFactStore;
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
  shadowEffect?: DecisionEffect;
  /** The rule that decided, carried so the explanation can cite its version. */
  rule?: RuleRef;
  /** What the agent may do instead, resolved from that rule rather than invented. */
  alternative?: Alternative;
  /** How the request compared against the task's declared scope. */
  scope?: ScopeComparison;
}

/** identity → policy → advisors → approval → audit; exactly one event per request. */
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

  /** Resolved per request, so a mode change lands on the next decision, not a restart. */
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

  /** The caller's testimony, not a verdict — the runtime cannot observe the world. */
  async recordOutcome(
    agentToken: string,
    report: ExecutionOutcomeReport,
  ): Promise<OutcomeRecording> {
    const agent = await this.resolveAgent(agentToken);
    if (!agent) return OUTCOME_UNAUTHORIZED;

    const [decided] = await this.deps.auditLog.query({
      eventId: report.decisionEventId,
      agentId: agent.id,
      limit: 1,
    });
    if (decided === undefined) return OUTCOME_UNKNOWN_DECISION;

    const defied =
      decided.effect !== DECISION_EFFECT.ALLOW &&
      report.status === EXECUTION_STATUS.SUCCEEDED;

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
      riskLevel: defied ? RISK_LEVEL.CRITICAL : outcomeRiskLevel(report),
      matchedPolicies: [],
      advisories: [],
      reason: defied
        ? `${describeOutcome(report)} — but this action was ${decided.effect}, not allowed`
        : describeOutcome(report),
      orgId: agent.orgId,
      decisionEventId: report.decisionEventId,
      executionStatus: report.status,
      rolledBack: report.rolledBack,
      rollbackFailed: report.rollbackError !== undefined,
      ...(defied ? { defiedVerdict: true as const } : {}),
    });
    await this.recordSideEffect(agent, report, defied);
    return defied ? OUTCOME_DEFIED : OUTCOME_RECORDED;
  }

  /**
   * What the action actually did, on the same timeline as the verdict that permitted
   * it. Without this a session shows what was decided and never what followed.
   */
  private async recordSideEffect(
    agent: AgentIdentity,
    report: ExecutionOutcomeReport,
    defied: boolean,
  ): Promise<void> {
    const store = this.deps.frames;
    const sessionId = report.sessionId;
    if (store === undefined || sessionId === undefined) return;
    try {
      await store.append({
        id: `frm_${randomUUID()}`,
        sessionId,
        agentId: agent.id,
        decisionId: report.decisionEventId,
        at: new Date().toISOString(),
        kind: FRAME_KIND.SIDE_EFFECT,
        summary: defied
          ? `${describeOutcome(report)} — after a verdict that was not allow`
          : describeOutcome(report),
      });
    } catch (err) {
      // The record is worth having, but never at the cost of the outcome.
      this.logger.error(
        `side-effect frame failed for ${report.decisionEventId}: ${String(err)}`,
      );
    }
  }

  /**
   * A verdict a seam reached on its own. The local gate refuses in-process so the
   * arguments never travel, which leaves the ledger with no record of the refusal and
   * `why` with nothing to explain. This is that record, reported after the fact: the
   * action, what it was against, the rule that matched and the reason it gave. The
   * payload that produced it stays on the machine that read it.
   */
  async recordSeamVerdict(
    agentToken: string,
    report: SeamVerdictReport,
  ): Promise<Decision | null> {
    const agent = await this.resolveAgent(agentToken);
    if (agent === null) return null;

    const eventId = randomUUID();
    const at = new Date().toISOString();
    const matched: MatchedPolicy[] =
      report.rule === undefined
        ? []
        : [{ name: report.rule, effect: report.effect, reason: report.reason }];

    await this.appendEvent({
      id: eventId,
      occurredAt: at,
      agentId: agent.id,
      agentName: agent.name,
      action: report.action,
      ...(report.target === undefined ? {} : { target: report.target }),
      ...(report.sessionId === undefined ? {} : { sessionId: report.sessionId }),
      effect: report.effect,
      riskLevel: RISK_LEVEL.LOW,
      matchedPolicies: matched.map((policy) => policy.name),
      advisories: [],
      reason: report.reason,
      orgId: agent.orgId,
      // Named, so a reader can tell a verdict this runtime made from one it was told.
      decidedBy: report.seam,
    });

    const decision: Decision = {
      eventId,
      effect: report.effect,
      riskLevel: RISK_LEVEL.LOW,
      reason: report.reason,
      matchedPolicies: matched,
      advisories: [],
      ...(report.alternative === undefined ? {} : { alternative: report.alternative }),
      mode: ENFORCEMENT_MODE.ENFORCE,
      evaluatedAt: at,
      latencyUs: 0,
    };
    // Built from the match the seam reported, never invented here.
    await this.saveExplanation(
      decision,
      {
        action: report.action,
        ...(report.target === undefined ? {} : { target: report.target }),
      },
      agent,
      undefined,
    );
    return decision;
  }

  /** Bookkeeping, not a decision: withholding the record would freeze the ledger. */
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

  /** Same pipeline as `assess`, rendered as constraints rather than a verdict. */
  async brief(agentToken: string, request: ActionRequest): Promise<ActionBriefing> {
    return buildActionBriefing(request, await this.assess(agentToken, request));
  }

  /** What the decision would be, without making it — nothing is recorded. */
  async assess(agentToken: string, request: ActionRequest): Promise<RiskAssessment> {
    const agent = await this.resolveAgent(agentToken);
    if (!agent) {
      return {
        effect: DECISION_EFFECT.WITHHOLD,
        riskLevel: RISK_LEVEL.CRITICAL,
        reason: DECISION_REASON.UNKNOWN_AGENT,
        matchedPolicies: [],
        advisories: [],
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
        effect: DECISION_EFFECT.WITHHOLD,
        riskLevel,
        reason: DECISION_REASON.CAPABILITY,
        matchedPolicies: [],
        advisories: [],
        ...levelOf(agent),
      };
    }

    const scope = await this.compareScope(request);
    const state = await this.stateInForce(request);
    const evaluation = this.deps.policyEngine.evaluate(request, {
      agentName: agent.name,
      now: new Date(),
      ...(scope === undefined ? {} : { scope: scope.match }),
      ...state,
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
      ...levelOf(agent),
    };
  }

  /** Pipeline entry for already-authenticated identities (e.g. mTLS client certs). */
  async authorizeAgent(
    agent: AgentIdentity | null,
    incoming: ActionRequest,
  ): Promise<Decision> {
    // Started before normalization, so the budget covers the whole hot path.
    const startedAt = process.hrtime.bigint();
    /* Every decision funnels through here, so this is the one place a request
       becomes canonical. Before it, `database.delete ` missed a rule naming
       `database.delete` and a block answered allow. The audit records the
       normalized form, because that is the request that was ruled on. */
    const request = normalizeActionRequest(incoming);
    if (!agent) {
      return this.finalize(startedAt, null, request, {
        effect: DECISION_EFFECT.WITHHOLD,
        reason: DECISION_REASON.UNKNOWN_AGENT,
      });
    }
    if (agent.status === AGENT_STATUS.SUSPENDED) {
      return this.finalize(startedAt, agent, request, {
        effect: DECISION_EFFECT.WITHHOLD,
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
      return this.finalize(startedAt, agent, request, {
        effect: DECISION_EFFECT.WITHHOLD,
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
    // mode: observeing a policy is a choice, admitting an unknown caller is not.
    const mode = resolveEnforcementMode(this.deps.enforcement ?? {}, request.environment);
    if (mode === ENFORCEMENT_MODE.OFF) {
      return this.finalize(startedAt, agent, request, {
        effect: DECISION_EFFECT.ALLOW,
        reason: ENFORCEMENT_REASON.DISABLED,
        enforcementMode: mode,
      });
    }

    if (request.approvalId) {
      const resolved = await this.applyApproval(
        startedAt,
        agent,
        request,
        await advise(),
      );
      if (resolved) return resolved;
    }

    const scope = await this.compareScope(request);
    const state = await this.stateInForce(request);
    const evaluation = this.deps.policyEngine.evaluate(request, {
      agentName: agent.name,
      now: new Date(),
      ...(scope === undefined ? {} : { scope: scope.match }),
      ...state,
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
      applied.shadowEffect === undefined
        ? limited.reason
        : `${ENFORCEMENT_REASON.OBSERVED}: ${limited.reason}`;
    // Two things can withhold a verdict — the environment's mode and a rule of
    // its own in monitor mode — and the audit should name the stricter of them.
    const shadowEffect = stricter(applied.shadowEffect, evaluation.shadowEffect);

    if (effect === DECISION_EFFECT.ESCALATE) {
      // Claimed only here, so the extra lookup stays off the allow path.
      const granted = await this.approvals.claimGrantFor(agent, request);
      if (granted) {
        return this.finalize(startedAt, agent, request, {
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
        return this.finalize(startedAt, agent, request, {
          effect: DECISION_EFFECT.WITHHOLD,
          reason: `${reason} — too many approvals already pending for this agent`,
          matchedPolicies: evaluation.matchedPolicies,
          advisories,
          enforcementMode: mode,
        });
      }
      return this.finalize(startedAt, agent, request, {
        effect,
        reason: `${DECISION_REASON.APPROVAL_PENDING}: ${reason}`,
        matchedPolicies: evaluation.matchedPolicies,
        advisories,
        approvalId: approval.id,
        approvers,
        enforcementMode: mode,
        rule: evaluation.rule,
        alternative: evaluation.alternative,
        scope,
      });
    }

    return this.finalize(startedAt, agent, request, {
      effect,
      reason,
      matchedPolicies: evaluation.matchedPolicies,
      advisories,
      enforcementMode: mode,
      rule: evaluation.rule,
      alternative: evaluation.alternative,
      scope,
      ...(shadowEffect === undefined ? {} : { shadowEffect }),
    });
  }

  /** Only an action that proceeds consumes a slot; a withheld one never held one. */
  private async applyRateLimits(
    agent: AgentIdentity,
    matched: MatchedPolicy[],
    verdict: DecisionEffect,
    verdictReason: string,
  ): Promise<{ effect: DecisionEffect; reason: string }> {
    const unchanged = { effect: verdict, reason: verdictReason };
    const limiter = this.deps.rateLimiter;
    if (limiter === undefined) return unchanged;
    if (verdict !== DECISION_EFFECT.ALLOW) return unchanged;

    for (const policy of matched) {
      const spec = policy.rateLimit;
      if (spec === undefined || policy.observed === true) continue;
      try {
        const allowed = await limiter.allow(
          `${RATE_LIMIT_RULE_PREFIX}:${policy.name}:${agent.id}`,
          spec.max,
          spec.windowSeconds,
        );
        if (allowed) continue;
        return {
          effect: DECISION_EFFECT.WITHHOLD,
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

  /** An advisor failure means no escalation, never a crash. */
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
    startedAt: bigint,
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
      return this.finalize(startedAt, agent, request, {
        effect: veto ? DECISION_EFFECT.WITHHOLD : DECISION_EFFECT.ALLOW,
        reason: veto
          ? `${DECISION_REASON.NON_OVERRIDABLE}: ${veto.reason}`
          : `${DECISION_REASON.APPROVAL_GRANTED} by ${approval.resolvedBy}`,
        advisories,
        approvalId: approval.id,
      });
    }
    if (consent === CONSENT.DENIED) {
      return this.finalize(startedAt, agent, request, {
        effect: DECISION_EFFECT.WITHHOLD,
        reason: `approval denied by ${approval.resolvedBy}`,
        advisories,
        approvalId: approval.id,
      });
    }
    return null;
  }

  private async finalize(
    startedAt: bigint,
    agent: AgentIdentity | null,
    request: ActionRequest,
    outcome: Outcome,
  ): Promise<Decision> {
    // Unauthenticated attempts are always critical — someone is probing with bad credentials.
    const riskLevel = agent
      ? classifyRisk(request.action, request.environment)
      : RISK_LEVEL.CRITICAL;
    const advisories = outcome.advisories ?? [];

    const mode = outcome.enforcementMode ?? DEFAULT_ENFORCEMENT_MODE;
    const decision: Decision = {
      eventId: randomUUID(),
      effect: outcome.effect,
      riskLevel,
      reason: outcome.reason,
      matchedPolicies: outcome.matchedPolicies ?? [],
      advisories,
      approvalId: outcome.approvalId,
      shadowEffect: outcome.shadowEffect,
      rule: outcome.rule,
      alternative: outcome.alternative,
      mode,
      evaluatedAt: new Date().toISOString(),
      latencyUs: Number((process.hrtime.bigint() - startedAt) / 1000n),
    };

    await this.saveExplanation(decision, request, agent, outcome.scope);
    await this.recordFrames(decision, request, agent);

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
      shadowEffect: outcome.shadowEffect,
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

  /**
   * State is distributed, not queried: the facts are read once and compared in process,
   * so a freeze refuses in microseconds rather than over a network the hot path forbids.
   * An unreadable store contributes no facts, which lets a state-bearing rule lapse
   * rather than refusing everything on an outage.
   */
  private async stateInForce(
    request: ActionRequest,
  ): Promise<{ state?: string[]; stateVersion?: string }> {
    const store = this.deps.state;
    if (store === undefined) return {};
    let facts;
    try {
      facts = await store.list();
    } catch (err) {
      this.logger.error(`state facts unreadable: ${String(err)}`);
      return {};
    }
    const { facts: live } = compileStateFacts(facts, new Date());
    const subject = {
      ...(request.environment === undefined
        ? {}
        : { environments: [request.environment] }),
      ...(request.projectId === undefined ? {} : { repositories: [request.projectId] }),
      ...(request.target === undefined ? {} : { services: [request.target] }),
    };
    const applies = live.filter((fact) => stateApplies(fact, subject));
    if (applies.length === 0) return { stateVersion: stateVersion(live) };
    return {
      state: [...new Set(applies.map((fact) => fact.kind))],
      stateVersion: stateVersion(live),
    };
  }

  /**
   * Scope is compared, not judged. The task is data the client declared; an unreadable
   * or absent one leaves the comparison undefined rather than assuming the request fits.
   */
  private async compareScope(
    request: ActionRequest,
  ): Promise<ScopeComparison | undefined> {
    const tasks = this.deps.tasks;
    const sessionId = request.sessionId;
    if (tasks === undefined || sessionId === undefined) return undefined;
    let task: Task | null;
    try {
      task = await tasks.findBySession(sessionId);
    } catch (err) {
      this.logger.error(`task lookup failed for session ${sessionId}: ${String(err)}`);
      return undefined;
    }
    if (task === null) return undefined;
    return compareDeclaredScope(
      task.declaredScope,
      subjectOf(request),
      (patterns, value) => matchesAny([...patterns], value),
    );
  }

  /** Built from the match, never regenerated: a failure here must not lose the verdict. */
  private async saveExplanation(
    decision: Decision,
    request: ActionRequest,
    agent: AgentIdentity | null,
    scope: ScopeComparison | undefined,
  ): Promise<void> {
    const store = this.deps.explanations;
    if (store === undefined) return;
    try {
      await store.save(
        buildExplanation({
          decision,
          request,
          ...(agent === null ? {} : { agentName: agent.name }),
          ...(scope === undefined ? {} : { scope }),
        }),
      );
    } catch (err) {
      this.logger.error(
        `explanation store failed for ${decision.eventId}: ${String(err)}`,
      );
    }
  }

  /**
   * Not only the verdict: the intent it ran under, the context it read and its trust,
   * and the verdict itself. Full fidelity on anything withheld or escalated, sampled on
   * the allowed majority, which is where the bytes are.
   */
  private async recordFrames(
    decision: Decision,
    request: ActionRequest,
    agent: AgentIdentity | null,
  ): Promise<void> {
    const store = this.deps.frames;
    const sessionId = request.sessionId;
    if (store === undefined || sessionId === undefined) return;

    const allowed = decision.effect === DECISION_EFFECT.ALLOW;
    if (!keepFrame(allowed, decision.eventId)) return;

    const agentId = agent === null ? UNKNOWN_AGENT_ID : agent.id;
    const base = {
      sessionId,
      agentId,
      decisionId: decision.eventId,
      at: decision.evaluatedAt,
    };
    const frames: Frame[] = [];

    const task = request.task;
    if (task !== undefined) {
      frames.push({
        ...base,
        id: `${decision.eventId}:intent`,
        kind: FRAME_KIND.INTENT,
        summary: task.statement,
      });
    }
    for (const block of request.context ?? []) {
      frames.push({
        ...base,
        id: `${decision.eventId}:retrieval:${digest(block.source)}`,
        kind: FRAME_KIND.RETRIEVAL,
        summary: block.source,
        // A ledger that stored what an agent read would be the thing worth stealing.
        payloadDigest: digest(block.content),
        contextTrust: block.trust,
      });
    }
    frames.push({
      ...base,
      id: `${decision.eventId}:verdict`,
      kind: FRAME_KIND.VERDICT,
      summary: `${decision.effect}: ${decision.reason}`,
    });

    for (const frame of frames) {
      try {
        await store.append(frame);
      } catch (err) {
        // The record is worth having, but never at the cost of the verdict.
        this.logger.error(`frame append failed for ${decision.eventId}: ${String(err)}`);
        return;
      }
    }
  }

  private async recordStats(agent: AgentIdentity, effect: DecisionEffect): Promise<void> {
    const stats = { ...agent.stats };
    if (effect === DECISION_EFFECT.ALLOW) stats.allowed += 1;
    if (effect === DECISION_EFFECT.WITHHOLD) stats.withheld += 1;
    if (effect === DECISION_EFFECT.ESCALATE) stats.approvalsRequested += 1;
    await this.agents.recordDecisionStats(agent, stats);
  }
}

/** The dimensions a request can be compared on. Nothing is inferred from the payload. */
function subjectOf(request: ActionRequest): ScopeSubject {
  return {
    ...(request.target === undefined ? {} : { path: request.target }),
    ...(request.projectId === undefined ? {} : { repository: request.projectId }),
    ...(request.environment === undefined ? {} : { environment: request.environment }),
  };
}

/** The named level a person granted, never a number this process worked out. */
function levelOf(agent: AgentIdentity): { autonomyLevel?: number } {
  return agent.autonomyLevel === undefined ? {} : { autonomyLevel: agent.autonomyLevel };
}
