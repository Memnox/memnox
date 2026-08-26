import { describe, expect, it } from 'vitest';
import {
  isReasoningLevel,
  REASONING_LEVEL,
  REASONING_LEVELS,
  thinkingBudgetFor,
} from '../src/reasoning';

describe('reasoning levels', () => {
  it('recognizes every published level and nothing else', () => {
    for (const level of REASONING_LEVELS) expect(isReasoningLevel(level)).toBe(true);
    expect(isReasoningLevel('maximum')).toBe(false);
    expect(isReasoningLevel('')).toBe(false);
  });
});

describe('thinking budget', () => {
  const ROOMY = 32_000;

  it('disables thinking outright at none', () => {
    expect(thinkingBudgetFor(REASONING_LEVEL.NONE, ROOMY)).toBeUndefined();
  });

  it('spends more the higher the level', () => {
    const low = thinkingBudgetFor(REASONING_LEVEL.LOW, ROOMY) ?? 0;
    const medium = thinkingBudgetFor(REASONING_LEVEL.MEDIUM, ROOMY) ?? 0;
    const high = thinkingBudgetFor(REASONING_LEVEL.HIGH, ROOMY) ?? 0;

    expect(low).toBeLessThan(medium);
    expect(medium).toBeLessThan(high);
  });

  it('always leaves room for the answer itself', () => {
    /* A budget at or above maxTokens is a 400 from the provider, so a caller
       that lowers its ceiling must not start failing. */
    for (const level of REASONING_LEVELS) {
      for (const maxTokens of [2_048, 4_096, 8_192, 32_000]) {
        const budget = thinkingBudgetFor(level, maxTokens);
        if (budget !== undefined) expect(budget).toBeLessThan(maxTokens);
      }
    }
  });

  it('gives up rather than asking for a budget below the provider minimum', () => {
    expect(thinkingBudgetFor(REASONING_LEVEL.HIGH, 1_500)).toBeUndefined();
  });

  it('clamps a high budget down to what a small request can afford', () => {
    const budget = thinkingBudgetFor(REASONING_LEVEL.HIGH, 8_192);

    expect(budget).toBeDefined();
    expect(budget).toBeLessThan(8_192);
  });
});
