/**
 * How hard a model is asked to think, as one word rather than a token budget.
 *
 * A budget is a provider's unit and changes between them; "how carefully should
 * this be considered" is the question somebody choosing a model is actually
 * answering. The mapping lives here so a stored setting survives a provider
 * changing its own numbers.
 */
export const REASONING_LEVEL = {
  NONE: 'none',
  LOW: 'low',
  MEDIUM: 'medium',
  HIGH: 'high',
} as const;

export type ReasoningLevel = (typeof REASONING_LEVEL)[keyof typeof REASONING_LEVEL];

export const REASONING_LEVELS: readonly ReasoningLevel[] = Object.values(REASONING_LEVEL);

/** Thinking tokens per level. `none` disables extended thinking outright. */
const REASONING_BUDGET: Record<ReasoningLevel, number> = {
  [REASONING_LEVEL.NONE]: 0,
  [REASONING_LEVEL.LOW]: 2_048,
  [REASONING_LEVEL.MEDIUM]: 8_192,
  [REASONING_LEVEL.HIGH]: 24_576,
};

/** Anthropic requires a thinking budget of at least this many tokens. */
const MIN_BUDGET = 1_024;

/** Room left for the answer itself once thinking has taken its share. */
const ANSWER_RESERVE = 1_024;

export function isReasoningLevel(value: string): value is ReasoningLevel {
  return (REASONING_LEVELS as readonly string[]).includes(value);
}

/**
 * The thinking budget for a level, clamped to fit inside the caller's own
 * `maxTokens`. Undefined means "do not enable thinking", which is the answer
 * for `none`, and also for a request too small to leave room for an answer
 * after thinking. Asking for a budget at or above `maxTokens` is a 400 from the
 * provider, so a caller that lowers its ceiling must not start failing.
 */
export function thinkingBudgetFor(
  level: ReasoningLevel,
  maxTokens: number,
): number | undefined {
  const wanted = REASONING_BUDGET[level];
  if (wanted === 0) return undefined;
  const affordable = Math.min(wanted, maxTokens - ANSWER_RESERVE);
  return affordable < MIN_BUDGET ? undefined : affordable;
}
