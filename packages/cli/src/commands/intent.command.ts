import type { Command } from 'commander';
import type { CliContext } from '../cli-context';
import { IntentClassifier } from '@memnox/intelligence';
import {
  buildLlmProvider,
  PROVIDER_CHOICES,
  type LlmProviderFactory,
} from '../llm-provider-option';

export function registerIntentCommand(
  program: Command,
  context: CliContext,
  buildProvider: LlmProviderFactory = buildLlmProvider,
): void {
  program
    .command('intent <goal>')
    .description(
      'Show what a stated goal would concretely do, and how risky each step is (BYOK LLM; advisory only)',
    )
    .option('--environment <environment>', 'environment the goal would run against')
    .option('--provider <provider>', PROVIDER_CHOICES.join('|'), PROVIDER_CHOICES[0])
    .option('--model <model>', 'override the provider default model')
    .action(
      async (
        goal: string,
        options: { environment?: string; provider: string; model?: string },
      ) => {
        const classifier = new IntentClassifier(
          buildProvider(options.provider, options.model),
        );
        const analysis = await classifier.classify(goal, options.environment);

        if (analysis.candidates.length === 0) {
          context.out.line('No concrete actions could be derived from that goal.');
          return;
        }
        context.out.line(`Goal        : ${analysis.goal}`);
        context.out.line(`Highest risk: ${analysis.highestRisk}`);
        context.out.line('Could involve:');
        for (const candidate of analysis.candidates) {
          const target = candidate.target ? ` ${candidate.target}` : '';
          context.out.line(
            `  [${candidate.riskLevel.padEnd(8)}] ${candidate.action}${target}${
              candidate.why ? ` — ${candidate.why}` : ''
            }`,
          );
        }
        context.out.note(
          '\nAdvisory only. The gate still decides on each action when it is actually attempted.',
        );
      },
    );
}
