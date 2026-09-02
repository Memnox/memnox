import type { Command } from 'commander';
import { toolsMatching, traceCapability } from '@memnox/discovery';
import type { CliContext } from '../cli-context';
import { defaultScanSeams, scanMachine, type ScanSeams } from '../machine-scan';

const LABEL_WIDTH = 14;

/**
 * Provenance for authority, not just for code. Tools arrive through servers, servers
 * arrive through a config file, and by the time an agent calls something surprising
 * nobody remembers which — so every field here is read back off the scan history.
 */
export function registerTraceCommand(
  program: Command,
  context: CliContext,
  buildSeams: (cwd: string) => ScanSeams = defaultScanSeams,
  cwd: () => string = () => process.cwd(),
): void {
  program
    .command('trace <tool>')
    .description('Where one tool came from: which server, which file, and when')
    .option('--json', 'emit the trace as JSON')
    .option(
      '--no-probe',
      'do not start MCP servers to ask what they hold; tools go uncounted',
    )
    .action(async (tool: string, options: { json?: boolean; probe: boolean }) => {
      const seams = buildSeams(cwd());
      const { snapshot } = await scanMachine(seams, { probe: options.probe });
      // Oldest first, this run's scan last: "it was already here" needs the whole run.
      const kept = await seams.snapshots.history();
      const trace = traceCapability(tool, kept);

      if (trace === null) {
        if (options.json === true) {
          context.out.line(JSON.stringify({ tool, found: false }, null, 2));
          return;
        }
        context.out.line(`No tool named "${tool}" on this machine.`);
        const near = toolsMatching(snapshot, tool);
        if (near.length > 0) {
          context.out.line('');
          for (const match of near.slice(0, 5)) {
            context.out.line(`  ${match.tool}  ${context.style.dim(match.server)}`);
          }
        }
        return;
      }

      if (options.json === true) {
        context.out.line(JSON.stringify(trace, null, 2));
        return;
      }

      const { out, style } = context;
      out.line('');
      out.line(row('tool', style.bold(trace.tool)));
      out.line(row('server', trace.server));
      out.line(row('reached by', trace.reachedBy.join(', ')));
      out.line('');
      out.line(row('granted by', trace.grantedBy));
      out.line(
        row(
          'first seen',
          trace.firstSeen ?? style.dim('before the oldest scan this machine kept'),
        ),
      );
      out.line('');
      out.line(row('effect', trace.effect.toUpperCase()));
      out.line('');
    });
}

function row(label: string, value: string): string {
  return `  ${label.padEnd(LABEL_WIDTH)}${value}`;
}
