import type { Command } from 'commander';
import type { CliContext } from '../cli-context';
import { DEFAULT_BASE_URL } from '../defaults';

const PERCENT = 100;
const LABEL_WIDTH = 18;

/**
 * One number a board can see, defended by the list underneath it. Every figure is about
 * the organization's own behaviour: what this product handled belongs in an internal
 * dashboard nobody sells.
 */
export function registerCoverageCommand(program: Command, context: CliContext): void {
  program
    .command('coverage')
    .description('How much of what your agents actually do is governed, and what is not')
    .option('--json', 'emit the coverage window as JSON')
    .option('--url <url>', `runtime base URL (default: ${DEFAULT_BASE_URL})`)
    .option('--admin-token <token>', 'admin token if the runtime requires one')
    .action(async (options: { json?: boolean; url?: string; adminToken?: string }) => {
      const { out, style } = context;
      const { client } = await context.connect(options);
      const window = await client.coverage();

      if (options.json === true) {
        out.line(JSON.stringify(window, null, 2));
        return;
      }

      if (window.actionsSeen === 0) {
        out.line('No actions decided yet — there is nothing to be covered or uncovered.');
        return;
      }

      out.line(style.bold('MEMNOX COVERAGE'));
      out.line('');
      out.line(
        `  ${style.bold(`${percent(window.coverage)}%`)} of what your agents do is governed`,
      );
      out.line('');
      out.line(
        `  ${'actions'.padEnd(LABEL_WIDTH)}${window.actionsGoverned}/${window.actionsSeen} distinct actions have a rule`,
      );
      out.line(
        `  ${'seams'.padEnd(LABEL_WIDTH)}${window.seamsCovered}/${window.seamsTotal} enforcing`,
      );
      out.line(
        `  ${'machines'.padEnd(LABEL_WIDTH)}${window.installsEnforcing}/${window.installsTotal} enforcing`,
      );
      out.line('');
      // Weighted by risk on purpose: a read loop would otherwise report near-total
      // coverage while every irreversible action in the company is ungoverned.
      out.line(
        style.dim(
          '  Weighted by risk, times seam coverage, times machine coverage. An agent',
        ),
      );
      out.line(style.dim('  governed on one seam of four is not a governed agent.'));

      if (window.topUngoverned.length > 0) {
        out.line('');
        out.line(style.bold('Nobody has ruled on these'));
        for (const action of window.topUngoverned) out.line(`  ${action}`);
      }

      if (window.blindTo.length > 0) {
        out.line('');
        out.line(style.bold('Your seams cannot see'));
        for (const blind of window.blindTo) out.line(`  ${style.warn(blind)}`);
      }
    });
}

function percent(share: number): number {
  return Math.round(share * PERCENT);
}
