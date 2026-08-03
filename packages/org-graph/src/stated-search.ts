import type { Stated } from './stated';

/** A word shorter than this carries no signal and matches almost everything. */
const MIN_TERM_LENGTH = 3;
/** A subject hit is worth more than a body hit: it is what the statement is about. */
const SUBJECT_WEIGHT = 3;
const STATEMENT_WEIGHT = 1;

export interface StatedHit {
  stated: Stated;
  score: number;
}

/**
 * Deterministic keyword search over what the organization states.
 *
 * Keyword and not embeddings, and that is a decision rather than a stage: this
 * feeds answers an agent acts on, so the same question has to return the same
 * statements on a runtime with no model key as on one with three. Semantic
 * recall belongs above this, ranking what this already found.
 */
export function searchStatements(
  statements: readonly Stated[],
  query: string,
  limit?: number,
): StatedHit[] {
  const terms = termsOf(query);
  if (terms.length === 0) return [];

  const hits = statements
    .map((stated) => ({ stated, score: scoreOf(stated, terms) }))
    .filter((hit) => hit.score > 0)
    .sort((left, right) => right.score - left.score);

  return limit === undefined ? hits : hits.slice(0, limit);
}

function scoreOf(stated: Stated, terms: readonly string[]): number {
  const subject = stated.subject.toLowerCase();
  const statement = stated.statement.toLowerCase();
  return terms.reduce((score, term) => {
    const inSubject = subject.includes(term) ? SUBJECT_WEIGHT : 0;
    const inStatement = statement.includes(term) ? STATEMENT_WEIGHT : 0;
    return score + inSubject + inStatement;
  }, 0);
}

function termsOf(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((term) => term.length >= MIN_TERM_LENGTH);
}
