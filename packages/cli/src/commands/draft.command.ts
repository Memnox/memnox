import type { Command } from 'commander';
import type { CliContext } from '../cli-context';
import { PolicyDrafter } from '@memnox/intelligence';
import {
  buildLlmProvider,
  PROVIDER_CHOICES,
  type LlmProviderFactory,
} from '../llm-provider-option';

export function registerDraftCommand(
  program: Command,
  context: CliContext,
  buildProvider: LlmProviderFactory = buildLlmProvider,
): void {
  program
    .command('draft <instruction>')
    .description(
      'Draft policy YAML from plain language (BYOK LLM; output is validated, you review and commit)',
    )
    .option('--provider <provider>', PROVIDER_CHOICES.join('|'), PROVIDER_CHOICES[0])
    .option('--model <model>', 'override the provider default model')
    .action(
      async (instruction: string, options: { provider: string; model?: string }) => {
        const drafter = new PolicyDrafter(buildProvider(options.provider, options.model));
        const draft = await drafter.draft(instruction);
        context.out.line(draft.yaml);
        context.out.note(
          `Drafted ${draft.document.policies.length} policy(ies) — review, then save and run "memnox validate".`,
        );
      },
    );
}
