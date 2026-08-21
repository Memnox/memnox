import type { DecisionRecord } from './decision-record';
import { isEnforcing } from './decision-record';
import {
  searchDecisions,
  SEARCH_DEFAULT_LIMIT,
  type DecisionSearchHit,
} from './decision-search';
import { indexNewItems, type EmbedFn } from './incremental-index';
import type { VectorIndex } from './vector-index';

/** Weights for reciprocal-rank fusion; keyword leads because it is exact. */
const KEYWORD_WEIGHT = 1;
const SEMANTIC_WEIGHT = 0.8;
/** Smooths rank fusion so the top hit does not dominate everything below it. */
const RANK_CONSTANT = 60;

export interface SemanticSearchDeps {
  index: VectorIndex;
  embed: EmbedFn;
  logger?: { warn(message: string): void };
}

function embeddableText(decision: DecisionRecord): string {
  return [decision.title, decision.statement, ...decision.actions].join('\n');
}

/** Degrades to keyword matching: search is a convenience, never a gate. */
export class DecisionSemanticSearch {
  constructor(private readonly deps: SemanticSearchDeps) {}

  /** Only enforcing decisions are searchable; retired ones must not resurface. */
  async index(decisions: readonly DecisionRecord[]): Promise<number> {
    return indexNewItems(
      this.deps.index,
      decisions
        .filter(isEnforcing)
        .map((decision) => ({ id: decision.id, text: embeddableText(decision) })),
      this.deps.embed,
    );
  }

  async search(
    decisions: readonly DecisionRecord[],
    query: string,
    limit: number = SEARCH_DEFAULT_LIMIT,
  ): Promise<DecisionSearchHit[]> {
    const keyword = searchDecisions([...decisions], query, limit);
    const semantic = await this.semanticHits(decisions, query, limit).catch(
      (error: unknown) => {
        if (this.deps.logger) {
          this.deps.logger.warn(`semantic search unavailable: ${String(error)}`);
        }
        return [] as DecisionSearchHit[];
      },
    );
    if (semantic.length === 0) return keyword;
    return fuse(keyword, semantic, limit);
  }

  private async semanticHits(
    decisions: readonly DecisionRecord[],
    query: string,
    limit: number,
  ): Promise<DecisionSearchHit[]> {
    const [queryVector] = await this.deps.embed([query]);
    if (!queryVector) return [];
    const byId = new Map(decisions.filter(isEnforcing).map((d) => [d.id, d]));
    const matches = await this.deps.index.query(queryVector, limit);
    return matches.flatMap((match) => {
      const decision = byId.get(match.id);
      return decision ? [{ decision, score: match.similarity }] : [];
    });
  }
}

/** Reciprocal rank fusion: position in each list matters, raw scores do not. */
function fuse(
  keyword: readonly DecisionSearchHit[],
  semantic: readonly DecisionSearchHit[],
  limit: number,
): DecisionSearchHit[] {
  const scores = new Map<string, { hit: DecisionSearchHit; score: number }>();

  const add = (hits: readonly DecisionSearchHit[], weight: number): void => {
    hits.forEach((hit, position) => {
      const contribution = weight / (RANK_CONSTANT + position + 1);
      const existing = scores.get(hit.decision.id);
      if (existing) existing.score += contribution;
      else scores.set(hit.decision.id, { hit, score: contribution });
    });
  };

  add(keyword, KEYWORD_WEIGHT);
  add(semantic, SEMANTIC_WEIGHT);

  return [...scores.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((entry) => ({ decision: entry.hit.decision, score: entry.score }));
}
