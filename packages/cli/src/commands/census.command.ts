import type { Command } from 'commander';
import type { CensusResponse } from '@memnox/sdk';
import type { CliContext } from '../cli-context';
import { DEFAULT_BASE_URL } from '../defaults';

const COUNT_WIDTH = 6;

/**
 * How many agents are there, who does each act for, and which of them nobody owns. A
 * runtime cannot answer that, which is exactly why it is the first thing worth paying
 * for — and why every row here links to the record that proved it.
 */
export function registerCensusCommand(program: Command, context: CliContext): void {
  program
    .command('census')
    .description('Every agent in the organization, from every source, with its evidence')
    .option('--tracked <n>', 'how many you thought there were — the gap is the finding')
    .option('--json', 'emit the census as JSON')
    .option('--url <url>', `runtime base URL (default: ${DEFAULT_BASE_URL})`)
    .option('--admin-token <token>', 'admin token if the runtime requires one')
    .action(
      async (options: {
        tracked?: string;
        json?: boolean;
        url?: string;
        adminToken?: string;
      }) => {
        const { out, style } = context;
        const { client } = await context.connect(options);
        const tracked =
          options.tracked === undefined ? undefined : Number(options.tracked);
        if (tracked !== undefined && !Number.isFinite(tracked)) {
          throw new Error('--tracked must be a number');
        }

        const census = await client.census(tracked);
        if (options.json === true) {
          out.line(JSON.stringify(census, null, 2));
          return;
        }
        render(context, census, tracked);
      },
    );
}

function render(
  context: CliContext,
  census: CensusResponse,
  tracked: number | undefined,
): void {
  const { out, style } = context;
  const { summary } = census;

  out.line(style.bold('AI WORKFORCE'));
  out.line('');
  const gap =
    census.gap === null || tracked === undefined
      ? ''
      : style.dim(`  you were tracking ${tracked}`);
  out.line(`  ${style.bold(String(summary.total))} agents${gap}`);

  if (summary.total === 0) {
    out.line('');
    out.line('Nothing has enrolled yet. This is a true answer, not an empty page.');
    return;
  }

  out.line('');
  out.line(style.bold('WHAT THEY CAN DO'));
  out.line('');
  warn(context, summary.noNamedOwner, 'no named owner');
  warn(context, summary.reachProduction, 'can reach production');
  warn(context, summary.reachCustomerData, 'can read customer records');
  warn(context, summary.destructive, 'can take a destructive action');
  // Naming the ungovernable is worth more than pretending otherwise.
  warn(context, summary.ungovernable, 'run somewhere we cannot instrument');

  out.line('');
  out.line(style.bold('WHERE THEY CAME FROM'));
  out.line('');
  for (const [source, count] of Object.entries(summary.bySource)) {
    out.line(`  ${source.padEnd(20)}${String(count).padStart(COUNT_WIDTH)}`);
  }

  if (census.unavailable.length > 0) {
    out.line('');
    out.line(style.warn(`  Could not read: ${census.unavailable.join(', ')}`));
    out.line(style.dim('  The count above is therefore a floor, not a total.'));
  }

  out.line('');
  out.line(style.dim('  Every count links to the record that produced it — use --json.'));
}

function warn(context: CliContext, count: number, label: string): void {
  if (count === 0) return;
  const { out, style } = context;
  out.line(`  ${style.warn('!')}  ${String(count).padStart(3)}  ${label}`);
}
