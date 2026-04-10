/** One step of a declared plan and the actions it may take. */
export interface PlanStep {
  name: string;
  /** Wildcard action patterns this step may perform. Empty = nothing. */
  allows: string[];
}

export interface AgentPlan {
  id: string;
  sessionId: string;
  agentId: string;
  steps: PlanStep[];
  /** Index of the step currently in force. */
  current: number;
  declaredAt: string;
  /** Set once the plan is finished or abandoned; a closed plan allows nothing. */
  closedAt?: string;
}

export const PLAN_SCOPE_REASON = {
  OUT_OF_SCOPE: 'action is outside the current plan step',
  PLAN_CLOSED: 'the declared plan is closed',
  EXHAUSTED: 'the plan has no step left to run',
} as const;

export type PlanScopeReason = (typeof PLAN_SCOPE_REASON)[keyof typeof PLAN_SCOPE_REASON];

export interface ScopeVerdict {
  withinScope: boolean;
  /** Why not, when it is out of scope. */
  reason?: PlanScopeReason;
  step?: string;
}

export const WITHIN_SCOPE: ScopeVerdict = { withinScope: true };

export function currentStep(plan: AgentPlan): PlanStep | undefined {
  return plan.steps[plan.current];
}

/**
 * A step's grant is only what it declared. Advancing is one-way, so a step that
 * has been left cannot be re-entered to reuse its permissions.
 */
export function evaluatePlanScope(
  plan: AgentPlan,
  action: string,
  matches: (patterns: string[] | undefined, value: string) => boolean,
): ScopeVerdict {
  if (plan.closedAt !== undefined) {
    return { withinScope: false, reason: PLAN_SCOPE_REASON.PLAN_CLOSED };
  }
  const step = currentStep(plan);
  if (step === undefined) {
    return { withinScope: false, reason: PLAN_SCOPE_REASON.EXHAUSTED };
  }
  // An empty allow-list grants nothing; matchesAny treats undefined as "any",
  // which would silently turn a scopeless step into a wildcard.
  if (step.allows.length === 0) {
    return {
      withinScope: false,
      reason: PLAN_SCOPE_REASON.OUT_OF_SCOPE,
      step: step.name,
    };
  }
  if (matches(step.allows, action)) return { withinScope: true, step: step.name };
  return {
    withinScope: false,
    reason: PLAN_SCOPE_REASON.OUT_OF_SCOPE,
    step: step.name,
  };
}

/** Advancing past the last step closes the plan rather than wrapping. */
export function advancePlan(plan: AgentPlan, at: string): AgentPlan {
  if (plan.closedAt !== undefined) return plan;
  const next = plan.current + 1;
  if (next >= plan.steps.length) {
    return { ...plan, current: plan.steps.length, closedAt: at };
  }
  return { ...plan, current: next };
}

export function closePlan(plan: AgentPlan, at: string): AgentPlan {
  return plan.closedAt === undefined ? { ...plan, closedAt: at } : plan;
}

export interface PlanStore {
  save(plan: AgentPlan): Promise<void>;
  findBySession(sessionId: string): Promise<AgentPlan | null>;
  findById(id: string): Promise<AgentPlan | null>;
}

/** Zero-infrastructure default; a plan lives only as long as its session. */
export class InMemoryPlanStore implements PlanStore {
  private readonly byId = new Map<string, AgentPlan>();

  async save(plan: AgentPlan): Promise<void> {
    this.byId.set(plan.id, plan);
  }

  /**
   * A closed plan still binds its session — otherwise an agent escapes scoping
   * by closing its own plan. An open plan wins so a new one supersedes the last.
   */
  async findBySession(sessionId: string): Promise<AgentPlan | null> {
    let closed: AgentPlan | null = null;
    for (const plan of this.byId.values()) {
      if (plan.sessionId !== sessionId) continue;
      if (plan.closedAt === undefined) return plan;
      closed = plan;
    }
    return closed;
  }

  async findById(id: string): Promise<AgentPlan | null> {
    return this.byId.get(id) ?? null;
  }
}
