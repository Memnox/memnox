import { homedir } from 'node:os';
import type { Command } from 'commander';
import { operationsReport, recommendation, type OperationsReport } from '@memnox/core';
import type { CliContext } from '../cli-context';
import { TONE } from '../flow';
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
      context.flow.open('memnox report');
      render(context, report);
    });
}

function render(context: CliContext, report: OperationsReport): void {
  const { flow, style } = context;

  if (report.actions === 0) {
    flow.close('Nothing was recorded in that window.');
    flow.hint('Run an agent under "memnox run" first.');
    return;
  }

  flow.rows('What the agents did', [
    { label: 'agents', value: String(report.agents) },
    { label: 'sessions', value: String(report.sessions) },
    { label: 'actions', value: String(report.actions) },
    { label: 'succeeded', value: String(report.succeeded) },
    { label: 'failed', value: String(report.failed) },
    { label: 'blocked', value: String(report.blocked) },
    { label: 'held', value: String(report.held) },
    { label: 'redone', value: String(report.retries) },
    /* The line people act on. Absent rather than zero when nobody reported a
       cost: this machine cannot price a model call, and a $0.00 would read as
       a fact. It names the seam rather than a command, because `memnox spend`
       was removed for exactly the reason this row exists and pointing at it
       sent people to a word that answers "nothing here". */
    {
      label: 'spend',
      value:
        report.spentUsd === null
          ? 'nobody reported any, and a cost rides on the event that had one'
          : `$${report.spentUsd.toFixed(2)}`,
    },
    ...(report.wastedUsd !== null && report.wastedUsd > 0
      ? [
          {
            label: 'wasted',
            value: style.warn(
              `$${report.wastedUsd.toFixed(2)} went on work that was redone`,
            ),
          },
        ]
      : []),
    ...(report.busiest === null
      ? []
      : [
          {
            label: 'busiest',
            value: `${report.busiest.agent} (${report.busiest.actions})`,
          },
        ]),
  ]);

  if (report.waste.length > 0) {
    flow.list(
      'Where the work went twice',
      report.waste.map((each) => ({
        tone: TONE.WARN,
        text: each.action,
        detail: [`${each.failures} failures of ${each.attempts}`],
      })),
    );
  }

  /* No footnote about spend: the row above already says either the figure or that
     nobody reported one. This said "nothing here can price a model call" under a
     line that had just printed $5.60, which is the screen arguing with itself. */
  flow.close(`${report.actions} action(s) across ${report.sessions} session(s).`);

  const advice = recommendation(report);
  if (advice !== null) flow.hint(advice);
}
