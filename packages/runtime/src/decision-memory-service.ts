import type { ActionEvent } from '@memnox/core';
import {
  buildDecisionDigest,
  buildDecisionHealthReport,
  DECISION_ENFORCEMENT,
  DECISION_MEMORY_ADVISOR,
  DecisionRegistry,
  searchDecisions,
  REVERSIBILITY_COST,
  type DecisionEnforcement,
  type DecisionHealthReport,
  type DecisionRecord,
  type DecisionSearchHit,
  type DecisionSemanticSearch,
  type DecisionStatus,
  type DecisionStore,
  type RegisterDecisionOutcome,
  type ReversibilityCost,
} from '@memnox/memory';

const VALID_ENFORCEMENTS: readonly string[] = Object.values(DECISION_ENFORCEMENT);
const VALID_REVERSIBILITY: readonly string[] = Object.values(REVERSIBILITY_COST);
const DECISION_SIGNAL_PREFIX = `${DECISION_MEMORY_ADVISOR}:decision:`;

/** Free-text fields arrive from HTTP; the service coerces them to domain values. */
export interface RecordDecisionInput {
  title: string;
  statement: string;
  owner: string;
  actions: string[];
  targets?: string[];
  environments?: string[];
  enforcement?: string;
  reversibilityCost?: string;
  sourceType?: string;
  sourceRef?: string;
  reviewAfter?: string;
  supersedes?: string;
}

export interface DecisionMemoryDeps {
  store: DecisionStore;
  /** Health counts enforcement hits, which live in the audit trail. */
  auditEvents: () => Promise<ActionEvent[]>;
  /** Present only when an embedding key is configured; keyword search runs regardless. */
  semanticSearch?: DecisionSemanticSearch;
}

/**
 * The decision corpus as an application service: registration invariants,
 * retrieval, and health. Routes above it only validate shapes and map outcomes
 * to status codes.
 */
export class DecisionMemoryService {
  private readonly registry: DecisionRegistry;

  constructor(private readonly deps: DecisionMemoryDeps) {
    this.registry = new DecisionRegistry(deps.store);
  }

  list(): Promise<DecisionRecord[]> {
    return this.deps.store.list();
  }

  record(input: RecordDecisionInput): Promise<RegisterDecisionOutcome> {
    return this.registry.register({
      title: input.title,
      statement: input.statement,
      owner: input.owner,
      actions: input.actions,
      targets: input.targets,
      environments: input.environments,
      // An unrecognised enforcement falls back to the strictest safe default.
      enforcement: VALID_ENFORCEMENTS.includes(input.enforcement ?? '')
        ? (input.enforcement as DecisionEnforcement)
        : DECISION_ENFORCEMENT.REQUIRE_APPROVAL,
      reversibilityCost: VALID_REVERSIBILITY.includes(input.reversibilityCost ?? '')
        ? (input.reversibilityCost as ReversibilityCost)
        : undefined,
      sourceType: input.sourceType,
      sourceRef: input.sourceRef,
      reviewAfter: input.reviewAfter,
      supersedes: input.supersedes,
    });
  }

  setStatus(id: string, status: DecisionStatus): Promise<DecisionRecord | null> {
    return this.registry.setStatus(id, status);
  }

  remove(id: string): Promise<boolean> {
    return this.deps.store.remove(id);
  }

  /** Hybrid when an embedding key is configured, keyword-only otherwise. */
  async search(query: string, limit?: number): Promise<DecisionSearchHit[]> {
    const decisions = await this.list();
    if (!this.deps.semanticSearch) return searchDecisions(decisions, query, limit);
    await this.deps.semanticSearch.index(decisions);
    return this.deps.semanticSearch.search(decisions, query, limit);
  }

  /** Deterministic keyword search, regardless of how the runtime is configured. */
  async searchByKeyword(query: string): Promise<DecisionSearchHit[]> {
    return searchDecisions(await this.list(), query);
  }

  async digest(): Promise<string> {
    return buildDecisionDigest(await this.list());
  }

  async health(): Promise<DecisionHealthReport> {
    const [decisions, events] = await Promise.all([this.list(), this.deps.auditEvents()]);
    return buildDecisionHealthReport(decisions, tallyViolations(events));
  }
}

/** A decision's enforcement hits are recorded as advisory signals on the event. */
function tallyViolations(events: readonly ActionEvent[]): Map<string, number> {
  const violations = new Map<string, number>();
  for (const event of events) {
    for (const signal of event.advisories) {
      if (!signal.startsWith(DECISION_SIGNAL_PREFIX)) continue;
      const decisionId = signal.slice(DECISION_SIGNAL_PREFIX.length);
      violations.set(decisionId, (violations.get(decisionId) ?? 0) + 1);
    }
  }
  return violations;
}
