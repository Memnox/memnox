import type {
  ActionAdvisor,
  ActionRequest,
  Advisory,
  AdvisoryContext,
} from '@memnox/core';
import { matchesAny } from '@memnox/policy-engine';
import {
  DECISION_ENFORCEMENT,
  isEnforcing,
  type DecisionRecord,
  type DecisionStore,
} from './decision-record';

export const DECISION_MEMORY_ADVISOR = 'decision-memory';

/**
 * Checks every action against recorded team decisions. A conflicting decision
 * escalates deterministically — the LLM-based extraction of decisions from
 * Slack/GitHub happens elsewhere; enforcement here is pure pattern matching.
 * A decision past its review date still enforces (flagged in health) —
 * constraints are reviewed and superseded, never silently expired.
 */
export class DecisionMemoryAdvisor implements ActionAdvisor {
  readonly name = DECISION_MEMORY_ADVISOR;

  constructor(
    private readonly store: DecisionStore,
    private readonly defaultApprovers: string[],
  ) {}

  async advise(request: ActionRequest, _context: AdvisoryContext): Promise<Advisory[]> {
    const records = await this.store.list();
    return records
      .filter((record) => isEnforcing(record) && this.conflicts(record, request))
      .map((record) => this.toAdvisory(record));
  }

  private conflicts(record: DecisionRecord, request: ActionRequest): boolean {
    return (
      matchesAny(record.actions, request.action) &&
      matchesAny(record.targets, request.target) &&
      matchesAny(record.environments, request.environment)
    );
  }

  private toAdvisory(record: DecisionRecord): Advisory {
    const escalateTo =
      record.enforcement === DECISION_ENFORCEMENT.WARN ? undefined : record.enforcement;
    return {
      source: this.name,
      escalateTo,
      reason: `conflicts with team decision "${record.title}" (${record.owner}): ${record.statement}`,
      approvers: this.defaultApprovers,
      signals: [`decision:${record.id}`],
    };
  }
}
