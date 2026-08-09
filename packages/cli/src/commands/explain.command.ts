import type { Command } from 'commander';
import type { CliContext } from '../cli-context';
import { DecisionExplainer } from '@memnox/intelligence';
import { DEFAULT_BASE_URL } from '../defaults';
import {
  buildLlmProvider,
  PROVIDER_CHOICES,
  type LlmProviderFactory,
} from '../llm-provider-option';

const EXPLAIN_SEARCH_WINDOW = 50;

export function registerExplainCommand(
  program: Command,
  context: CliContext,
  buildProvider: LlmProviderFactory = buildLlmProvider,
): void {
  program
    .command('explain [eventId]')
    .description(
      'Explain an audit decision in plain language (BYOK LLM; defaults to the most recent event)',
    )
    .option('--url <url>', `runtime base URL (default: ${DEFAULT_BASE_URL})`)
    .option('--admin-token <token>', 'admin token if the runtime requires one')
    .option('--provider <provider>', PROVIDER_CHOICES.join('|'), PROVIDER_CHOICES[0])
    .option('--model <model>', 'override the provider default model')
    .action(
      async (
        eventId: string | undefined,
        options: { url?: string; adminToken?: string; provider: string; model?: string },
      ) => {
        const { client } = await context.connect(options);
        const events = await client.recentAudit(EXPLAIN_SEARCH_WINDOW);
        const event = eventId
          ? events.find((candidate) => candidate.id === eventId)
          : events[0];
        if (!event) {
          throw new Error(
            eventId
              ? `no audit event "${eventId}" in the last ${EXPLAIN_SEARCH_WINDOW} events`
              : 'the audit log is empty — nothing to explain',
          );
        }
        const explainer = new DecisionExplainer(
          buildProvider(options.provider, options.model),
        );
        context.out.line(`${event.action} → ${event.effect} (${event.occurredAt})`);
        context.out.line(await explainer.explain(event));
      },
    );
}
