/**
 * What led up to a decision, read from what was recorded and never from a model: the task
 * somebody declared for the session, and the steps the session took just before it.
 */
import {
  LEDGER_SESSION_LIMIT,
  SessionTasks,
  type MemnoxEvent,
  type SessionTask,
  type SqliteEventStore,
} from '@memnox/core';

import type { CliContext } from '../../cli-context';

/** Enough steps to see where the agent was heading, few enough to read at a glance. */
const STEPS_BEFORE = 3;

export interface LeadUp {
  task: SessionTask | null;
  before: MemnoxEvent[];
}

export async function leadUpTo(
  store: SqliteEventStore,
  event: MemnoxEvent,
  home: string,
): Promise<LeadUp> {
  const task = await new SessionTasks(home).read(event.sessionId).catch(() => null);
  const session = await store.query({
    sessionId: event.sessionId,
    until: event.at,
    limit: LEDGER_SESSION_LIMIT,
  });
  // Oldest first from the store, so the last few are the ones just before.
  const before = session
    .filter((each) => each.id !== event.id && each.at <= event.at)
    .slice(-STEPS_BEFORE);
  return { task, before };
}

export function renderLeadUp(context: CliContext, leadUp: LeadUp): void {
  const { flow, style } = context;
  if (leadUp.task !== null) {
    const paths = leadUp.task.scope.paths ?? [];
    flow.rows('The task', [
      { label: 'asked for', value: leadUp.task.statement },
      ...(paths.length === 0 ? [] : [{ label: 'paths', value: paths.join(', ') }]),
    ]);
  }
  if (leadUp.before.length === 0) return;
  flow.rows(
    'Just before',
    leadUp.before.map((each) => ({
      label: each.at.slice(11, 19),
      value: `${each.operation}${each.target === undefined ? '' : ` ${each.target}`}  ${style.dim(each.effect)}`,
    })),
  );
}
