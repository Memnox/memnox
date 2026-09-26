/** One session on screen: its files, the systems it read and changed, and what was stopped. */
import type { SessionSummary } from '@memnox/core';

import type { CliContext } from '../cli-context';
import { TONE, type FlowRow } from '../flow';

export function renderSessionSummary(context: CliContext, summary: SessionSummary): void {
  const { flow, style } = context;
  flow.rows(`Session ${summary.sessionId}`, summaryRows(context, summary));
  if (summary.systems.length > 0) {
    flow.table(
      'Outside this machine',
      ['System', 'Reads', 'Changes'],
      summary.systems.map((system) => [
        system.name,
        String(system.reads),
        system.changes === 0 ? style.dim('0') : style.warn(String(system.changes)),
      ]),
    );
  }
  if (summary.blocked.length > 0) {
    flow.list(
      'Stopped',
      summary.blocked.map((each) => ({
        tone: TONE.WARN,
        text:
          each.target === undefined ? each.operation : `${each.operation} ${each.target}`,
        detail: [each.reason],
      })),
    );
  }
  flow.close(`${summary.actions} action(s) in this session.`);
  flow.hint(`memnox replay ${summary.sessionId}   every step, in order`);
}

function summaryRows(context: CliContext, summary: SessionSummary): FlowRow[] {
  const { style } = context;
  return [
    { label: 'agent', value: summary.agent },
    { label: 'from', value: summary.started },
    { label: 'to', value: summary.ended },
    { label: 'files read', value: String(summary.filesRead) },
    { label: 'files changed', value: String(summary.filesChanged) },
    { label: 'held', value: String(summary.held) },
    { label: 'approved', value: String(summary.approved) },
    {
      label: 'changed outside',
      value:
        summary.outsideChanges === 0
          ? style.ok('nothing outside this machine')
          : style.warn(String(summary.outsideChanges)),
    },
    {
      label: 'blocked',
      value: summary.blockedCount === 0 ? '0' : style.warn(String(summary.blockedCount)),
    },
  ];
}
