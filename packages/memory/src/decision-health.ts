import type { DecisionRecord } from './decision-record';
import { isEnforcing } from './decision-record';

/** Decisions untouched this long without a review date are considered stale. */
export const STALE_DECISION_DAYS = 90;
/** This many enforcement hits marks a decision as frequently violated. */
export const FREQUENT_VIOLATION_THRESHOLD = 3;

const HEALTH_MAX_SCORE = 100;
const STALE_PENALTY_WEIGHT = 40;
const VIOLATED_PENALTY_WEIGHT = 40;
const NEVER_REFERENCED_PENALTY_WEIGHT = 20;
const MS_PER_DAY = 86_400_000;

export interface DecisionHealthEntry {
  id: string;
  title: string;
  violations: number;
  stale: boolean;
  neverReferenced: boolean;
  dueForReview: boolean;
}

export interface DecisionHealthReport {
  /** 0-100. Penalizes stale, frequently-violated, and never-referenced decisions. */
  score: number;
  activeDecisions: number;
  stale: number;
  frequentlyViolated: number;
  neverReferenced: number;
  entries: DecisionHealthEntry[];
}

/** Violations are the decay signal; aged constraints are flagged, never dropped. */
export function buildDecisionHealthReport(
  decisions: DecisionRecord[],
  violationsByDecisionId: Map<string, number>,
  now: Date = new Date(),
): DecisionHealthReport {
  const active = decisions.filter(isEnforcing);
  const staleCutoff = new Date(now.getTime() - STALE_DECISION_DAYS * MS_PER_DAY);

  const entries = active.map((decision): DecisionHealthEntry => {
    const violations = violationsByDecisionId.get(decision.id) ?? 0;
    const dueForReview = Boolean(
      decision.reviewAfter && decision.reviewAfter <= now.toISOString(),
    );
    return {
      id: decision.id,
      title: decision.title,
      violations,
      stale:
        dueForReview ||
        (!decision.reviewAfter && decision.decidedAt <= staleCutoff.toISOString()),
      neverReferenced: violations === 0,
      dueForReview,
    };
  });

  const total = entries.length;
  const stale = entries.filter((entry) => entry.stale).length;
  const frequentlyViolated = entries.filter(
    (entry) => entry.violations >= FREQUENT_VIOLATION_THRESHOLD,
  ).length;
  const neverReferenced = entries.filter((entry) => entry.neverReferenced).length;

  const score =
    total === 0
      ? HEALTH_MAX_SCORE
      : HEALTH_MAX_SCORE -
        Math.round((stale / total) * STALE_PENALTY_WEIGHT) -
        Math.round((frequentlyViolated / total) * VIOLATED_PENALTY_WEIGHT) -
        Math.round((neverReferenced / total) * NEVER_REFERENCED_PENALTY_WEIGHT);

  return {
    score,
    activeDecisions: total,
    stale,
    frequentlyViolated,
    neverReferenced,
    entries,
  };
}
