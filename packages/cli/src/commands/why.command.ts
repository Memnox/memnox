import type { Command } from 'commander';
import type { ExplanationEvidence, ExplanationLine } from '@memnox/core';
import { EXPLANATION_EVIDENCE } from '@memnox/core';
import type { CliContext } from '../cli-context';
import { DEFAULT_BASE_URL } from '../defaults';

const EXIT_NOT_FOUND = 1;
const NUMBER_WIDTH = 3;

/**
 * Five lines read back off the record. Nothing here is generated: an explanation
 * produced after the fact by a model is a plausible story about a decision.
 */
export function registerWhyCommand(program: Command, context: CliContext): void {
  program
    .command('why <decisionId>')
    .description(
      'Why one decision came out the way it did, in five lines from the record',
    )
    .option('--json', 'emit the stored explanation as JSON')
    .option('--url <url>', `runtime base URL (default: ${DEFAULT_BASE_URL})`)
    .option('--admin-token <token>', 'admin token if the runtime requires one')
    .action(
      async (
        decisionId: string,
        options: { json?: boolean; url?: string; adminToken?: string },
      ) => {
        const { out, style } = context;
        const { client } = await context.connect(options);
        const explanation = await client.why(decisionId);
        if (explanation === null) {
          out.note(`no explanation recorded for "${decisionId}"`);
          process.exitCode = EXIT_NOT_FOUND;
          return;
        }

        if (options.json === true) {
          out.line(JSON.stringify(explanation, null, 2));
          return;
        }

        out.line(style.bold(`WHY  ${explanation.decisionId}`));
        out.line('');
        explanation.lines.forEach((line: ExplanationLine, index: number) => {
          out.line(`  ${String(index + 1).padStart(NUMBER_WIDTH)}  ${line.claim}`);
          out.line(`       ${style.dim(citation(line.evidence))}`);
        });
      },
    );
}

/** Every line traces to the rule version or the context block it came from. */
function citation(evidence: ExplanationEvidence): string {
  if (evidence.kind === EXPLANATION_EVIDENCE.RULE) {
    return `rule ${evidence.rule.id} v${evidence.rule.version}`;
  }
  if (evidence.kind === EXPLANATION_EVIDENCE.CONTEXT) {
    return `context ${evidence.context.source} (${evidence.context.trust})`;
  }
  if (evidence.kind === EXPLANATION_EVIDENCE.SCOPE) {
    return `declared ${evidence.dimension}: ${evidence.declared.join(', ')}`;
  }
  return `request ${evidence.field}=${evidence.value}`;
}
