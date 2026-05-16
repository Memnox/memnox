import type {
  ActionAdvisor,
  ActionRequest,
  Advisory,
  AdvisoryContext,
  PlanStore,
} from '@memnox/core';
import { DECISION_EFFECT, evaluatePlanScope } from '@memnox/core';
import { matchesAny } from '@memnox/policy-engine';

export const PLAN_SCOPE_ADVISOR = 'plan-scope';
export const RISK_SIGNAL_OUT_OF_PLAN_SCOPE = 'out-of-plan-scope';

/**
 * Narrows an autonomous run to the step it declared. A session with no plan is
 * ungoverned by this advisor — declaring one is opt-in, and a missing plan must
 * not block ordinary work.
 */
export class PlanScopeAdvisor implements ActionAdvisor {
  readonly name = PLAN_SCOPE_ADVISOR;

  constructor(private readonly plans: PlanStore) {}

  async advise(request: ActionRequest, _context: AdvisoryContext): Promise<Advisory[]> {
    if (request.sessionId === undefined) return [];

    const plan = await this.plans.findBySession(request.sessionId);
    if (plan === null) return [];

    const verdict = evaluatePlanScope(plan, request.action, matchesAny);
    if (verdict.withinScope) return [];

    const step = verdict.step === undefined ? 'none' : verdict.step;
    return [
      {
        source: this.name,
        escalateTo: DECISION_EFFECT.BLOCK,
        reason: `${verdict.reason} (step "${step}")`,
        signals: [RISK_SIGNAL_OUT_OF_PLAN_SCOPE],
      },
    ];
  }
}
