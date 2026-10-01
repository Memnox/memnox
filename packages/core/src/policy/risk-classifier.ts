import type { RiskLevel } from '../constants/risk.constants';
import {
  DESTRUCTIVE_VERBS,
  MUTATING_VERBS,
  READ_ONLY_VERBS,
  RISK_ESCALATION_ENVIRONMENTS,
  RISK_LEVEL,
  RISK_ORDER,
} from '../constants/risk.constants';

/**
 * Actions split on ".", "_", "-" and camelCase boundaries, because verb table actions are
 * joined with dashes and MCP tools are often camelCase, so "gh.repo-delete" and
 * "mcp.deleteRepo" both yield the verb "delete".
 */
const ACTION_SEGMENT_SEPARATOR = /[._-]|(?<=[a-z0-9])(?=[A-Z])/;

/** Rule-based on purpose: risk must be explainable and reproducible. */
export function classifyRisk(action: string, environment?: string): RiskLevel {
  const segments = action
    .split(ACTION_SEGMENT_SEPARATOR)
    .map((segment) => segment.toLowerCase())
    .filter((segment) => segment !== '');
  let level: RiskLevel = RISK_LEVEL.MEDIUM;

  if (segments.some((segment) => DESTRUCTIVE_VERBS.includes(segment))) {
    level = RISK_LEVEL.HIGH;
  } else if (segments.some((segment) => MUTATING_VERBS.includes(segment))) {
    level = RISK_LEVEL.MEDIUM;
  } else if (segments.some((segment) => READ_ONLY_VERBS.includes(segment))) {
    level = RISK_LEVEL.LOW;
  }

  if (environment && RISK_ESCALATION_ENVIRONMENTS.includes(environment.toLowerCase())) {
    level = raiseOneLevel(level);
  }
  return level;
}

/** One rung up, and never past the top. */
function raiseOneLevel(level: RiskLevel): RiskLevel {
  const index = RISK_ORDER.indexOf(level);
  return RISK_ORDER[Math.min(index + 1, RISK_ORDER.length - 1)] ?? level;
}
