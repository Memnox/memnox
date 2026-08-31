import type {
  ActionAdvisor,
  ActionEvent,
  ActionRequest,
  Advisory,
  AdvisoryContext,
  AuditLog,
} from '@memnox/core';
import { DECISION_EFFECT, DESTRUCTIVE_VERBS } from '@memnox/core';
import {
  BASELINE_WINDOW_EVENTS,
  BURST_THRESHOLD_ACTIONS,
  BURST_WINDOW_MS,
  REPEATED_BLOCK_THRESHOLD,
  REPEATED_BLOCK_WINDOW_MS,
  RISK_SIGNAL,
} from './risk.constants';

export const BEHAVIOR_ADVISOR = 'behavior-guard';

const ACTION_VERB_SEPARATOR = '.';

/** Deterministic and explainable; predictive models belong in the commercial engine. */
export class BehaviorAdvisor implements ActionAdvisor {
  readonly name = BEHAVIOR_ADVISOR;

  constructor(
    private readonly auditLog: AuditLog,
    private readonly approvers: string[],
  ) {}

  async advise(request: ActionRequest, context: AdvisoryContext): Promise<Advisory[]> {
    const history = await this.auditLog.query({
      agentId: context.agent.id,
      limit: BASELINE_WINDOW_EVENTS,
    });
    const advisories: Advisory[] = [];

    const novel = this.detectNovelDestructiveAction(request, history);
    if (novel) advisories.push(novel);

    const burst = this.detectBurst(history);
    if (burst) advisories.push(burst);

    const probing = this.detectRepeatedBlocks(history);
    if (probing) advisories.push(probing);

    return advisories;
  }

  /** A destructive verb this agent has never used before needs a human look. */
  private detectNovelDestructiveAction(
    request: ActionRequest,
    history: ActionEvent[],
  ): Advisory | null {
    const segments = request.action.split(ACTION_VERB_SEPARATOR);
    const lastSegment = segments[segments.length - 1];
    const verb = lastSegment === undefined ? '' : lastSegment.toLowerCase();
    if (!DESTRUCTIVE_VERBS.includes(verb)) return null;
    if (history.some((event) => event.action === request.action)) return null;
    if (history.length === 0) return null;
    return {
      source: this.name,
      escalateTo: DECISION_EFFECT.ESCALATE,
      reason: `first time this agent attempts "${request.action}" — outside its behavioral baseline`,
      approvers: this.approvers,
      signals: [RISK_SIGNAL.NOVEL_DESTRUCTIVE_ACTION],
    };
  }

  /** Sudden action storms are flagged (signal-only) so humans can review the session. */
  private detectBurst(history: ActionEvent[]): Advisory | null {
    const windowStart = new Date(Date.now() - BURST_WINDOW_MS).toISOString();
    const recentCount = history.filter((event) => event.occurredAt >= windowStart).length;
    if (recentCount < BURST_THRESHOLD_ACTIONS) return null;
    return {
      source: this.name,
      reason: `${recentCount} actions in the last ${BURST_WINDOW_MS / 1_000}s — unusually high rate`,
      signals: [RISK_SIGNAL.ACTION_BURST],
    };
  }

  /** An agent repeatedly hitting withholds is probing its boundaries — require a human. */
  private detectRepeatedBlocks(history: ActionEvent[]): Advisory | null {
    const windowStart = new Date(Date.now() - REPEATED_BLOCK_WINDOW_MS).toISOString();
    const blockedCount = history.filter(
      (event) =>
        event.occurredAt >= windowStart && event.effect === DECISION_EFFECT.WITHHOLD,
    ).length;
    if (blockedCount < REPEATED_BLOCK_THRESHOLD) return null;
    return {
      source: this.name,
      escalateTo: DECISION_EFFECT.ESCALATE,
      reason: `${blockedCount} withheld attempts in the last ${REPEATED_BLOCK_WINDOW_MS / 60_000} minutes — agent is probing policy boundaries`,
      approvers: this.approvers,
      signals: [RISK_SIGNAL.REPEATED_BLOCKS],
    };
  }
}
