import { cwd } from 'node:process';
import type { Command } from 'commander';
import {
  classifyActionClass,
  toolsMatching,
  traceCapability,
  type CapabilityTrace,
} from '@memnox/core';
import type { CliContext } from '../cli-context';
import { defaultScanSeams, scanMachine, type ScanSeams } from '../machine-scan';

const LABEL_WIDTH = 10;

function row(context: CliContext, label: string, value: string): void {
  context.out.line(`  ${label.padEnd(LABEL_WIDTH)}${value}`);
}

/** Every field is read off a scan, so the chain is evidence rather than a guess. */
function renderTrace(context: CliContext, trace: CapabilityTrace): void {
  const { out, style } = context;
  out.line('');
  out.line(style.bold(trace.tool));
  out.line('');
  row(context, 'server', trace.server);
  row(context, 'declared', trace.grantedBy);
  row(context, 'class', `${trace.effect} — ${classifyActionClass(trace.tool).class}`);
  row(
    context,
    'reached by',
    trace.reachedBy.length === 0
      ? 'no agent here launches it'
      : trace.reachedBy.join(', '),
  );
  row(
    context,
    'first seen',
    trace.firstSeen ?? 'at least as long as the kept scans go back',
  );
  out.line('');
}

export function registerExplainCommand(
  program: Command,
  context: CliContext,
  buildSeams: (dir: string) => ScanSeams = defaultScanSeams,
): void {
  program
    .command('explain <capability>')
    .description('Where one capability came from, and what class it is')
    .option('--json', 'machine-readable output')
    .action(async (capability: string, options: { json?: boolean }) => {
      const seams = buildSeams(cwd());
      const { snapshot } = await scanMachine(seams, { probe: false });
      const history = await seams.snapshots.history();

      const trace = traceCapability(capability, [...history, snapshot]);
      if (trace === null) {
        // Naming near misses beats a bare "not found" for a half-remembered tool.
        const near = toolsMatching(snapshot, capability);
        if (near.length === 0) {
          throw new Error(`Nothing here provides "${capability}". Run "memnox scan".`);
        }
        context.out.line(
          `No capability is named exactly "${capability}". Close matches:`,
        );
        for (const each of near) context.out.line(`  ${each.server}.${each.tool}`);
        return;
      }

      if (options.json === true) {
        context.out.line(JSON.stringify(trace, null, 2));
        return;
      }
      renderTrace(context, trace);
    });
}
