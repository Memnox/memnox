import { describe, expect, it } from 'vitest';
import { DECISION_EFFECT } from '@memnox/core';
import type { LlmProvider } from '@memnox/intelligence';
import { registerDraftCommand } from '../src/commands/draft.command';
import type { LlmProviderFactory } from '../src/llm-provider-option';
import { runCommand } from './cli-harness';

/** Canned completions, so no BYOK command reaches a network in tests. */
function stubProvider(completion: string): LlmProviderFactory {
  const provider: LlmProvider = {
    name: 'stub',
    complete: async () => completion,
  };
  return () => provider;
}

describe('memnox draft', () => {
  const runDraft = (
    args: string[],
    factory: LlmProviderFactory,
  ): ReturnType<typeof runCommand> =>
    runCommand(
      (program, context) => registerDraftCommand(program, context, factory),
      ['draft', ...args],
    );

  const drafted = JSON.stringify({
    version: 1,
    policies: [
      {
        name: 'no-prod-deletes',
        match: { actions: ['database.delete'], environments: ['production'] },
        decision: { effect: DECISION_EFFECT.WITHHOLD, reason: 'never' },
      },
    ],
  });

  it('prints the YAML on stdout so it can be redirected to a file', async () => {
    const { out } = await runDraft(['block production deletes'], stubProvider(drafted));

    expect(out.text).toContain('no-prod-deletes');
    expect(out.text).toContain('database.delete');
  });

  it('keeps the review reminder on stderr, out of the redirected YAML', async () => {
    const { out } = await runDraft(['block production deletes'], stubProvider(drafted));

    expect(out.notes.join('\n')).toContain('Drafted 1 policy(ies)');
    expect(out.notes.join('\n')).toContain('memnox validate');
    expect(out.text).not.toContain('memnox validate');
  });
});
