import type {
  ActionAdvisor,
  ActionRequest,
  Advisory,
  AdvisoryContext,
  AuditLog,
} from '@memnox/core';
import { DECISION_EFFECT } from '@memnox/core';
import { TOKEN_BUDGET_WINDOW_EVENTS } from './risk.constants';

export const TOKEN_BUDGET_ADVISOR = 'token-budget';
/** Agents report LLM spend as check({action: "llm.spend", target: "<tokens>"}). */
export const LLM_SPEND_ACTION = 'llm.spend';
export const RISK_SIGNAL_TOKEN_BUDGET_EXCEEDED = 'token-budget-exceeded';
/** What the proxy decides under; spend is recorded separately as llm.spend. */
export const LLM_INFER_ACTION = 'llm.infer';

/**
 * Caps cumulative LLM spend per session. Spend is reconstructed from the most
 * recent TOKEN_BUDGET_WINDOW_EVENTS audited events of the session (allowed
 * llm.spend), so the cap survives restarts and needs no extra state.
 */
export class TokenBudgetAdvisor implements ActionAdvisor {
  readonly name = TOKEN_BUDGET_ADVISOR;

  constructor(
    private readonly auditLog: AuditLog,
    private readonly sessionBudget: number,
  ) {}

  async advise(request: ActionRequest, _context: AdvisoryContext): Promise<Advisory[]> {
    const governed =
      request.action === LLM_SPEND_ACTION || request.action === LLM_INFER_ACTION;
    if (!governed || !request.sessionId) return [];

    // An inference carries no token count yet — the cap is on what is already
    // spent, so the call after the budget runs out is the one that stops.
    const requested =
      request.action === LLM_SPEND_ACTION ? Number(request.target ?? 0) : 0;
    if (
      request.action === LLM_SPEND_ACTION &&
      (!Number.isFinite(requested) || requested <= 0)
    ) {
      return [];
    }

    const events = await this.auditLog.query({
      sessionId: request.sessionId,
      limit: TOKEN_BUDGET_WINDOW_EVENTS,
    });
    const spent = events
      .filter(
        (event) =>
          event.action === LLM_SPEND_ACTION && event.effect === DECISION_EFFECT.ALLOW,
      )
      .reduce((total, event) => total + (Number(event.target) || 0), 0);

    if (spent + requested <= this.sessionBudget) return [];
    return [
      {
        source: this.name,
        escalateTo: DECISION_EFFECT.BLOCK,
        reason: `session token budget exceeded: ${spent + requested} of ${this.sessionBudget} tokens`,
        signals: [RISK_SIGNAL_TOKEN_BUDGET_EXCEEDED],
      },
    ];
  }
}
