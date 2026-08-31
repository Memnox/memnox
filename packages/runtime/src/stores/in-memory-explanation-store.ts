import type { Explanation, ExplanationStore } from '@memnox/core';

/** Bounded: an explanation outlives its decision only until the window rolls past it. */
export const EXPLANATION_RETENTION = 10_000;

export class InMemoryExplanationStore implements ExplanationStore {
  private readonly byDecision = new Map<string, Explanation>();

  constructor(private readonly retention: number = EXPLANATION_RETENTION) {}

  async save(explanation: Explanation): Promise<void> {
    this.byDecision.set(explanation.decisionId, explanation);
    // Insertion order is decision order, so the oldest key is the first one.
    while (this.byDecision.size > this.retention) {
      const oldest = this.byDecision.keys().next();
      if (oldest.done === true) break;
      this.byDecision.delete(oldest.value);
    }
  }

  async findByDecision(decisionId: string): Promise<Explanation | null> {
    return this.byDecision.get(decisionId) ?? null;
  }
}
