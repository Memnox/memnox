import type { LlmProvider } from './llm-provider';

const EXPLAIN_MAX_TOKENS = 2_048;

const EXPLAIN_SYSTEM_PROMPT =
  'You explain AI-agent governance decisions to engineers in two or three plain sentences. ' +
  'The decision was already made deterministically — never second-guess it, only explain it.';

/** Satisfied by a live Decision or an audit ActionEvent alike. */
export interface ExplainableDecision {
  action: string;
  target?: string;
  environment?: string;
  effect: string;
  riskLevel: string;
  reason: string;
  matchedPolicies: string[];
  advisories: string[];
}

/** Turns a deterministic decision into a human-readable explanation. Advisory only. */
export class DecisionExplainer {
  constructor(private readonly provider: LlmProvider) {}

  async explain(decision: ExplainableDecision): Promise<string> {
    return this.provider.complete({
      system: EXPLAIN_SYSTEM_PROMPT,
      prompt: JSON.stringify(decision, null, 2),
      maxTokens: EXPLAIN_MAX_TOKENS,
    });
  }
}
