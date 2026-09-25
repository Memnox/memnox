import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openLedger, type MemnoxEvent } from '@memnox/core';
import {
  keepSessionSummary,
  SESSION_SUMMARY_OPERATION,
} from '../src/session-summary-row';

function row(id: string, operation: string, at: string): MemnoxEvent {
  return {
    id,
    schemaVersion: 1,
    at,
    sessionId: 's1',
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

describe('a hooked session that ends', () => {
  it('leaves one row summing it up, which no later count of work includes', async () => {
    const home = await mkdtemp(join(tmpdir(), 'memnox-summary-'));
    const ledger = openLedger(home);
    await ledger?.append(row('e1', 'gh.pr-view', '2026-09-25T10:00:01.000Z'));
    await ledger?.append(row('e2', 'railway.logs', '2026-09-25T10:00:02.000Z'));
    ledger?.close();

    await keepSessionSummary(home, 's1', new Date('2026-09-25T10:05:00.000Z'));

    const reopened = openLedger(home);
    const all = (await reopened?.query({ sessionId: 's1', withConfig: true })) ?? [];
    const work = (await reopened?.query({ sessionId: 's1' })) ?? [];
    reopened?.close();
    const summary = all.find((each) => each.operation === SESSION_SUMMARY_OPERATION);
    expect(summary?.reason).toContain('2 action(s)');
    expect(summary?.reason).toContain('gh 1 read');
    expect(work).toHaveLength(2);
  });
});
