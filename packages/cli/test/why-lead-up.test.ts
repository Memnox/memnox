import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SessionTasks, SqliteEventStore, type MemnoxEvent } from '@memnox/core';
import { leadUpTo } from '../src/commands/why/lead-up';

function row(
  id: string,
  at: string,
  operation: string,
  sessionId = 'ses_1',
): MemnoxEvent {
  return {
    id,
    schemaVersion: 1,
    at,
    sessionId,
    agent: 'claude-code',
    actorType: 'agent',
    surface: 'shell',
    operation,
    class: 'read',
    effect: 'allow',
    mode: 'enforce',
    reason: 'no rule matched',
  } as MemnoxEvent;
}

describe('what led up to a decision', () => {
  it('is the declared task and the steps just before, in order', async () => {
    const home = await mkdtemp(join(tmpdir(), 'memnox-why-'));
    const store = new SqliteEventStore(join(home, 'memnox.db'));
    const rows = [
      row('e1', '2026-09-25T10:00:01.000Z', 'gh.pr-view'),
      row('e2', '2026-09-25T10:00:02.000Z', 'railway.logs'),
      row('e3', '2026-09-25T10:00:03.000Z', 'stripe.events-list'),
      row('e4', '2026-09-25T10:00:04.000Z', 'psql.select'),
      row('e5', '2026-09-25T10:00:05.000Z', 'stripe.refunds-create'),
      row('e6', '2026-09-25T10:00:06.000Z', 'gh.pr-view'),
      row('x1', '2026-09-25T10:00:04.500Z', 'gh.pr-merge', 'ses_other'),
    ];
    for (const each of rows) await store.append(each);
    await new SessionTasks(home).declare({
      id: 'tsk_1',
      sessionId: 'ses_1',
      statement: 'investigate the failed payment for order 481',
      scope: { paths: ['src/payments'] },
      declaredAt: '2026-09-25T09:59:00.000Z',
    });

    const leadUp = await leadUpTo(store, rows[4] as MemnoxEvent, home);
    expect(leadUp.task?.statement).toBe('investigate the failed payment for order 481');
    expect(leadUp.before.map((each) => each.operation)).toEqual([
      'railway.logs',
      'stripe.events-list',
      'psql.select',
    ]);
    store.close?.();
  });
});
