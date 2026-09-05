import { homedir } from 'node:os';
import type { Command } from 'commander';
import { inventoryOf, renderShareCard, shareCardFor } from '@memnox/core';
import type { CliContext } from '../cli-context';
import { readLocalCounts, type LocalCounts } from '../local-counts';
import { defaultScanSeams, scanMachine, type ScanSeams } from '../machine-scan';
import { renderMachine } from '../scan/machine-report';
import { renderServerReview } from '../scan/server-review';
import { renderTools } from '../scan/tool-listing';
import { renderUsage } from '../scan/usage-report';
import { unknownCommand } from '../unknown-command';

/**
 * Runs with no account, no key and no network. Nothing is transmitted, which is the
 * only reason a security engineer runs this on a laptop holding production credentials.
 */
export function registerScanCommand(
  program: Command,
  context: CliContext,
  buildSeams: (cwd: string) => ScanSeams = defaultScanSeams,
  cwd: () => string = () => process.cwd(),
  counts: () => Promise<LocalCounts> = () => readLocalCounts(homedir()),
): void {
  program
    .command('scan', { isDefault: true })
    // The word people reach for first. `memnox` alone runs it either way.
    .description(
      'What can act on this machine, and what it can reach. No account, no network.',
    )
    /* Bare `memnox` runs this, but `memnox audti` must not: with a default command
       commander hands an unknown word here as an argument. Refusing it as an excess
       argument blamed `discover` for a word the user never typed, so it is caught
       here instead and named for what it is. Hidden from the usage line. */
    .usage('[options]')
    .argument('[unrecognized...]')
    .option('--json', 'emit the report as JSON')
    .option('--tools', 'list every tool by what it does, server by server')
    .option('--mcp <server>', 'review one MCP server before you trust it')
    .option('--usage <window>', 'what was granted against what was used, e.g. 7d')
    .option('--save', 'keep this scan, so a later "memnox diff" has a baseline')
    .option('--share', 'a card of counts only, safe to paste anywhere')
    .option(
      '--no-probe',
      'do not start MCP servers to ask what they hold; tools go uncounted',
    )
    .action(
      async (
        unrecognized: string[],
        options: {
          json?: boolean;
          tools?: boolean;
          probe: boolean;
          mcp?: string;
          save?: boolean;
          usage?: string;
          share?: boolean;
        },
      ) => {
        if (unrecognized.length > 0) {
          throw new Error(unknownCommand(program, unrecognized[0] as string));
        }
        // Kept only when asked: a scan every command runs would churn the history.
        const { report, snapshot } = await scanMachine(buildSeams(cwd()), {
          probe: options.probe,
          save: options.save === true,
        });
        if (options.share === true) {
          const card = shareCardFor(inventoryOf(report, snapshot.takenAt));
          if (options.json === true) context.out.json(card);
          else context.out.line(renderShareCard(card));
          return;
        }
        if (options.usage !== undefined) {
          await renderUsage(context, report, options.usage, options.json === true);
          return;
        }
        if (options.mcp !== undefined) {
          renderServerReview(context, report, options.mcp, options.json === true);
          return;
        }
        if (options.json === true) {
          // The inventory, not the raw report: this is the shape that leaves the process.
          context.out.json(inventoryOf(report, snapshot.takenAt));
          return;
        }
        if (options.tools === true) {
          renderTools(context, report);
          return;
        }
        renderMachine(context, report, await counts());
      },
    );
}
