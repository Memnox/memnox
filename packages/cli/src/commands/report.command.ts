import { homedir } from 'node:os';
import type { Command } from 'commander';
import { operationsReport, recommendation, type OperationsReport } from '@memnox/core';
import type { CliContext } from '../cli-context';
import { withEvents } from '../event-store';

/**
 * What the agents did today, and what of it was wasted.
 *
 * The waste line is the one people act on. The same command failing forty times costs
 * real money and nobody notices, because each individual failure looks like an
 * ordinary bad afternoon and only the total says otherwise.
 */
export function registerReportCommand(
  program: Command,
  context: CliContext,
  home: () => string = homedir,
  now: () => Date = () => new Date(),
): void {
  program
    .command('report')
    .description('What your agents did in a window, and what of it was redone')
    .option('--since <window>', 'how far back, e.g. 1d', '1d')
    .option('--json', 'machine-readable output')
    .action(async (options: { since: string; json?: boolean }) => {
      const until = now().toISOString();
      const days = Number.parseInt(options.since, 10);
      const since = new Date(
        now().getTime() - (Number.isNaN(days) ? 1 : days) * 24 * 60 * 60_000,
      ).toISOString();

      const events = await withEvents(home(), (store) =>
        store.query({ since, limit: 50_000 }),
      );
      const report = operationsReport(events, since, until);

      if (options.json === true) {
        context.out.json(report);
        return;
      }
      render(context, report);
    });
}

function render(context: CliContext, report: OperationsReport): void {
  const { out, style } = context;

  if (report.actions === 0) {
    out.line('Nothing was recorded in that window.');
    out.note('Run an agent under "memnox run" first.');
    return;
  }

  out.line('');
  out.line(style.bold('AGENT OPERATIONS'));
  out.line('');
  row(context, 'Agents', String(report.agents));
  row(context, 'Sessions', String(report.sessions));
  row(context, 'Actions', String(report.actions));
  row(context, 'Succeeded', String(report.succeeded));
  row(context, 'Failed', String(report.failed));
  row(context, 'Blocked', String(report.blocked));
  row(context, 'Held', String(report.held));
  row(context, 'Redone', String(report.retries));

  /* The line people act on. Absent rather than zero when nobody reported a cost:
     this machine cannot price a model call, and a $0.00 would read as a fact. */
  if (report.spentUsd === null) {
    row(context, 'Spend', 'nobody reported any — "memnox spend <usd>" records it');
  } else {
    row(context, 'Spend', `$${report.spentUsd.toFixed(2)}`);
    if (report.wastedUsd !== null && report.wastedUsd > 0) {
      row(
        context,
        'Wasted',
        style.warn(`$${report.wastedUsd.toFixed(2)} went on work that was redone`),
      );
    }
  }

  if (report.busiest !== null) {
    out.line('');
    row(context, 'Busiest', `${report.busiest.agent} (${report.busiest.actions})`);
  }

  if (report.waste.length > 0) {
    out.line('');
    out.line(style.bold('WHERE THE WORK WENT TWICE'));
    out.line('');
    for (const each of report.waste) {
      out.line(
        `  ${style.warn('!')}  ${each.action}  ${each.failures} failures of ${each.attempts}`,
      );
    }
  }

  /* No footnote about spend: the row above already says either the figure or that
     nobody reported one. This said "nothing here can price a model call" under a
     line that had just printed $5.60, which is the screen arguing with itself. */
  out.line('');

  const advice = recommendation(report);
  if (advice !== null) out.note(advice);
}

function row(context: CliContext, label: string, value: string): void {
  context.out.line(`  ${label.padEnd(12)}${value}`);
}
