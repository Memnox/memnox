import { AGENT_ROTATE_ACTION, EXECUTION_OUTCOME_ACTION } from '@memnox/core';
import { LLM_SPEND_ACTION } from './token-budget-advisor';

/** Not authorization decisions, so coverage counts have to exclude them. */
export const BOOKKEEPING_ACTIONS: readonly string[] = [
  EXECUTION_OUTCOME_ACTION,
  AGENT_ROTATE_ACTION,
  LLM_SPEND_ACTION,
];
