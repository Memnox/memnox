import type {
  ActionAdvisor,
  ActionRequest,
  Advisory,
  AdvisoryContext,
  RiskLevel,
} from '@memnox/core';
import { computeTrustScore, DECISION_EFFECT, RISK_LEVEL } from '@memnox/core';
import { classifyRisk } from '@memnox/policy-engine';
import { RISK_SIGNAL, TRUST_SCORE_APPROVAL_THRESHOLD } from './risk.constants';

export const TRUST_ADVISOR = 'trust-guard';

const ESCALATING_RISK_LEVELS: readonly RiskLevel[] = [
  RISK_LEVEL.HIGH,
  RISK_LEVEL.CRITICAL,
];

/** An agent whose audited history eroded its score needs a human for risky actions. */
export class TrustAdvisor implements ActionAdvisor {
  readonly name = TRUST_ADVISOR;

  constructor(private readonly approvers: string[]) {}

  async advise(request: ActionRequest, context: AdvisoryContext): Promise<Advisory[]> {
    const score = computeTrustScore(context.agent.stats);
    if (score >= TRUST_SCORE_APPROVAL_THRESHOLD) return [];
    const risk = classifyRisk(request.action, request.environment);
    if (!ESCALATING_RISK_LEVELS.includes(risk)) return [];
    return [
      {
        source: this.name,
        escalateTo: DECISION_EFFECT.ESCALATE,
        reason: `trust score ${score} is below ${TRUST_SCORE_APPROVAL_THRESHOLD} — ${risk}-risk actions need a human sign-off`,
        approvers: this.approvers,
        signals: [RISK_SIGNAL.LOW_TRUST_SCORE],
      },
    ];
  }
}
