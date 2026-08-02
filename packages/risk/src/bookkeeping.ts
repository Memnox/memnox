import { AGENT_ROTATE_ACTION, EXECUTION_OUTCOME_ACTION } from '@memnox/core';
import { LLM_SPEND_ACTION } from './token-budget-advisor';

/**
 * Audited bookkeeping rather than authorization decisions, so they are not
 * actions anyone could report an execution outcome for. Anything counting
 * verification coverage has to exclude them or the denominator is wrong.
 */
export const BOOKKEEPING_ACTIONS: readonly string[] = [
  EXECUTION_OUTCOME_ACTION,
  AGENT_ROTATE_ACTION,
  LLM_SPEND_ACTION,
];
