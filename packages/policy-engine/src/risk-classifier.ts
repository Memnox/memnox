import type { RiskLevel } from '@memnox/core';
import {
  DESTRUCTIVE_VERBS,
  MUTATING_VERBS,
  READ_ONLY_VERBS,
  RISK_ESCALATION_ENVIRONMENTS,
  RISK_LEVEL,
  RISK_ORDER,
} from '@memnox/core';

/** Actions split on both "." and "_" so "mcp.delete_repo" yields [mcp, delete, repo]. */
const ACTION_SEGMENT_SEPARATOR = /[._]/;

/**
 * Deterministic baseline risk from the action's verb segments and environment.
 * Destructive beats mutating beats read-only when several segments match.
 * This is intentionally rule-based — risk must be explainable and reproducible.
 */
export function classifyRisk(action: string, environment?: string): RiskLevel {
  const segments = action.toLowerCase().split(ACTION_SEGMENT_SEPARATOR);
  let level: RiskLevel = RISK_LEVEL.MEDIUM;

  if (segments.some((segment) => DESTRUCTIVE_VERBS.includes(segment))) {
    level = RISK_LEVEL.HIGH;
  } else if (segments.some((segment) => MUTATING_VERBS.includes(segment))) {
    level = RISK_LEVEL.MEDIUM;
  } else if (segments.some((segment) => READ_ONLY_VERBS.includes(segment))) {
    level = RISK_LEVEL.LOW;
  }

  if (environment && RISK_ESCALATION_ENVIRONMENTS.includes(environment.toLowerCase())) {
    level = escalate(level);
  }
  return level;
}

function escalate(level: RiskLevel): RiskLevel {
  const index = RISK_ORDER.indexOf(level);
  return RISK_ORDER[Math.min(index + 1, RISK_ORDER.length - 1)] ?? level;
}
