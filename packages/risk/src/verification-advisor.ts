import type {
  ActionAdvisor,
  ActionEvent,
  ActionRequest,
  Advisory,
  AdvisoryContext,
  AuditLog,
} from '@memnox/core';
import {
  DECISION_EFFECT,
  DESTRUCTIVE_VERBS,
  EXECUTION_OUTCOME_ACTION,
  EXECUTION_OUTCOME_GRACE_MS,
} from '@memnox/core';
import { BOOKKEEPING_ACTIONS } from './bookkeeping';
import {
  BASELINE_WINDOW_EVENTS,
  RISK_SIGNAL,
  UNREPORTED_OUTCOME_THRESHOLD,
} from './risk.constants';

export const VERIFICATION_ADVISOR = 'verification-guard';

const ACTION_VERB_SEPARATOR = '.';

/** Autonomy is earned by reporting outcomes; scoped to destructive verbs. */
export class VerificationAdvisor implements ActionAdvisor {
  readonly name = VERIFICATION_ADVISOR;

  constructor(
    private readonly auditLog: AuditLog,
    private readonly approvers: string[],
  ) {}

  async advise(request: ActionRequest, context: AdvisoryContext): Promise<Advisory[]> {
    if (!isDestructive(request.action)) return [];

    const history = await this.auditLog.query({
      agentId: context.agent.id,
      limit: BASELINE_WINDOW_EVENTS,
    });
    const overdue = countOverdueOutcomes(
      history,
      Date.now() - EXECUTION_OUTCOME_GRACE_MS,
    );
    if (overdue < UNREPORTED_OUTCOME_THRESHOLD) return [];

    return [
      {
        source: this.name,
        escalateTo: DECISION_EFFECT.ESCALATE,
        reason: `${overdue} of this agent's recent allowed actions never reported an outcome — its trail is unverified`,
        approvers: this.approvers,
        signals: [RISK_SIGNAL.UNVERIFIED_EXECUTION],
      },
    ];
  }
}

function isDestructive(action: string): boolean {
  const segments = action.split(ACTION_VERB_SEPARATOR);
  const lastSegment = segments[segments.length - 1];
  if (lastSegment === undefined) return false;
  return DESTRUCTIVE_VERBS.includes(lastSegment.toLowerCase());
}

/** Overdue allowed decisions with no testimony; bookkeeping events excluded. */
function countOverdueOutcomes(history: ActionEvent[], overdueBefore: number): number {
  const reported = new Set<string>();
  for (const event of history) {
    if (event.action !== EXECUTION_OUTCOME_ACTION) continue;
    if (event.decisionEventId === undefined) continue;
    reported.add(event.decisionEventId);
  }

  let overdue = 0;
  for (const event of history) {
    if (event.effect !== DECISION_EFFECT.ALLOW) continue;
    if (BOOKKEEPING_ACTIONS.includes(event.action)) continue;
    if (Date.parse(event.occurredAt) > overdueBefore) continue;
    if (reported.has(event.id)) continue;
    overdue += 1;
  }
  return overdue;
}
