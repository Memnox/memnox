import { describe, expect, it } from 'vitest';
import { DecisionExplainer } from '../src/decision-explainer';
import type { LlmCompletionRequest, LlmProvider } from '../src/llm-provider';

/** Real in-memory provider: records requests, returns a canned completion. */
class InMemoryProvider implements LlmProvider {
  readonly name = 'in-memory';
  readonly requests: LlmCompletionRequest[] = [];

  async complete(request: LlmCompletionRequest): Promise<string> {
    this.requests.push(request);
    return 'Blocked because production database deletions are never allowed.';
  }
}

describe('DecisionExplainer', () => {
  it('sends the full decision context and returns the explanation verbatim', async () => {
    const provider = new InMemoryProvider();
    const explainer = new DecisionExplainer(provider);

    const explanation = await explainer.explain({
      action: 'database.delete',
      target: 'users',
      environment: 'production',
      effect: 'block',
      riskLevel: 'critical',
      reason: 'No AI database deletion',
      matchedPolicies: ['production-database-protection'],
      advisories: ['decision-memory'],
    });

    expect(explanation).toContain('Blocked because');
    const prompt = provider.requests[0]?.prompt ?? '';
    expect(prompt).toContain('database.delete');
    expect(prompt).toContain('production-database-protection');
    expect(provider.requests[0]?.system).toContain('never second-guess');
  });
});
