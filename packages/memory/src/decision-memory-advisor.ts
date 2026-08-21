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

/** Pure pattern matching; a decision past review still enforces, never expires silently. */
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
      this.inScope(record, request) &&
      matchesAny(record.actions, request.action) &&
      matchesAny(record.targets, request.target) &&
      matchesAny(record.environments, request.environment)
    );
  }

  /** A decision scoped to one project never constrains another; an unscoped one is org-wide. */
  private inScope(record: DecisionRecord, request: ActionRequest): boolean {
    if (record.projectId === undefined) return true;
    return record.projectId === request.projectId;
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
