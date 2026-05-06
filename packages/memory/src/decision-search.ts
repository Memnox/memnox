import type { DecisionRecord } from './decision-record';
import { isEnforcing } from './decision-record';

export const SEARCH_DEFAULT_LIMIT = 10;
/** Title hits matter more than body hits. */
const TITLE_WEIGHT = 2;
const MIN_TOKEN_LENGTH = 3;

export interface DecisionSearchHit {
  decision: DecisionRecord;
  score: number;
}

/**
 * Deterministic keyword search over the active corpus — token overlap scored
 * against title (weighted), statement, and action patterns. An embedding
 * backend can implement a richer search behind the same signature.
 */
export function searchDecisions(
  decisions: DecisionRecord[],
  query: string,
  limit: number = SEARCH_DEFAULT_LIMIT,
): DecisionSearchHit[] {
  const terms = tokenize(query);
  if (terms.length === 0) return [];

  return decisions
    .filter(isEnforcing)
    .map((decision) => ({ decision, score: scoreDecision(decision, terms) }))
    .filter((hit) => hit.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

function scoreDecision(decision: DecisionRecord, terms: string[]): number {
  const title = new Set(tokenize(decision.title));
  const body = new Set([
    ...tokenize(decision.statement),
    ...decision.actions.flatMap(tokenize),
    ...(decision.targets ?? []).flatMap(tokenize),
  ]);
  return terms.reduce((score, term) => {
    if (title.has(term)) return score + TITLE_WEIGHT;
    if (body.has(term)) return score + 1;
    return score;
  }, 0);
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= MIN_TOKEN_LENGTH);
}
