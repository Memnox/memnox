import { homedir } from 'node:os';

import type { Command } from 'commander';

import {
  LEDGER_SESSION_LIMIT,
  LEDGER_WINDOW_LIMIT,
  operationsReport,
  recommendation,
  summarizeSession,
  type OperationsReport,
} from '@memnox/core';

import type { CliContext } from '../cli-context';
import { resolveWindowStart } from '../days-back';
import { TONE, type FlowRow } from '../flow';
import { withEvents } from '../event-store';
import { renderSessionSummary } from '../report/session-view';

/**
 * `memnox report`: what the agents did in a window, and what of it was wasted, because
 * each failure looks like an ordinary bad afternoon and only the total says otherwise.
 */

/** What `--since` falls back to when it was given something that is not a number. */
const DEFAULT_WINDOW_DAYS = 1;

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
    .option('--session <id>', 'one session instead of a window: its id, or "last"')
    .option('--json', 'machine-readable output')
    .action(async (options: ReportOptions) =>
      options.session === undefined
        ? runReport(context, home, now, options)
        : runSessionReport(context, home(), options.session, options.json === true),
    );
}

interface ReportOptions {
  since: string;
  json?: boolean;
  session?: string;
}

/** The session that last recorded anything, which is the one somebody just finished. */
const LAST_SESSION = 'last';

async function runSessionReport(
  context: CliContext,
  home: string,
  asked: string,
  asJson: boolean,
): Promise<void> {
  const sessionId = asked === LAST_SESSION ? await lastSession(home) : asked;
  const events =
    sessionId === null
      ? []
      : await withEvents(home, (store) =>
          store.query({ sessionId, limit: LEDGER_SESSION_LIMIT }),
        );
  const summary = summarizeSession(events);
  if (asJson) {
    context.out.json(summary);
    return;
  }
  context.flow.open('memnox report');
  if (summary === null) {
    context.flow.close(`Nothing was recorded for session ${asked}.`);
    context.flow.hint('memnox timeline   the sessions that were');
    return;
  }
  renderSessionSummary(context, summary);
}

async function lastSession(home: string): Promise<string | null> {
  const [latest] = await withEvents(home, (store) => store.query({ limit: 1 }));
  return latest?.sessionId ?? null;
}

/** What the agents did in a window, and what of it was redone. */
async function runReport(
  context: CliContext,
  home: () => string,
  now: () => Date,
  options: ReportOptions,
): Promise<void> {
  const moment = now();
  const until = moment.toISOString();
  const since = resolveWindowStart(options.since, moment, DEFAULT_WINDOW_DAYS);

  const events = await withEvents(home(), (store) =>
    store.query({ since, limit: LEDGER_WINDOW_LIMIT }),
  );
  const report = operationsReport(events, since, until);

  if (options.json === true) {
    context.out.json(report);
    return;
  }
  context.flow.open('memnox report');
  renderReport(context, report);
}

function renderReport(context: CliContext, report: OperationsReport): void {
  const { flow } = context;
  if (report.actions === 0) {
    flow.close('Nothing was recorded in that window.');
    flow.hint('Run an agent under "memnox run" first.');
    return;
  }

  flow.rows('What the agents did', totalRowsOf(context, report));
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
  flow.close(`${report.actions} action(s) across ${report.sessions} session(s).`);

  const advice = recommendation(report);
  if (advice !== null) flow.hint(advice);
}

/** The totals card, saying nobody reported a spend rather than printing zero. */
function totalRowsOf(context: CliContext, report: OperationsReport): FlowRow[] {
  return [
    { label: 'agents', value: String(report.agents) },
    { label: 'sessions', value: String(report.sessions) },
    { label: 'actions', value: String(report.actions) },
    { label: 'succeeded', value: String(report.succeeded) },
    { label: 'failed', value: String(report.failed) },
    { label: 'blocked', value: String(report.blocked) },
    { label: 'held', value: String(report.held) },
    { label: 'redone', value: String(report.retries) },
    // This machine cannot price a model call, so a $0.00 here would read as a fact.
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
            value: context.style.warn(
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
  ];
}
