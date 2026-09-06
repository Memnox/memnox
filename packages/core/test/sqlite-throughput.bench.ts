import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SqliteEventStore } from '../src/event/sqlite-store';
import { EVENT_SCHEMA_VERSION, type MemnoxEvent } from '../src/event/event';

/**
 * The ledger's throughput requirement, kept out of the correctness suite.
 *
 * A wall-clock assertion in a unit test measures whatever else the machine is doing,
 * and a suite that fails under load is one people learn to re-run rather than read.
 * Run this on purpose — `pnpm bench` — where a slow answer is a finding rather than
 * an accident of scheduling.
 */
const TARGET_MS = 2000;
const ROWS = 10_000;

function event(over: Partial<MemnoxEvent> = {}): MemnoxEvent {
  return {
    id: 'evt_1',
    schemaVersion: EVENT_SCHEMA_VERSION,
    at: '2026-09-05T10:00:00.000Z',
    sessionId: 'ses_1',
    agent: 'claude-code',
    actorType: 'agent',
    surface: 'mcp',
    operation: 'github.merge_pull_request',
    class: 'write',
    effect: 'deny',
    mode: 'enforce',
    reason: 'production is frozen',
    ...over,
  };
}

describe('ledger throughput', () => {
  it(`appends ${ROWS} events in under ${TARGET_MS}ms`, async () => {
    const db = SqliteEventStore.forHome(await mkdtemp(join(tmpdir(), 'memnox-bench-')));
    const started = Date.now();
    for (let n = 0; n < ROWS; n += 1) {
      await db.append(event({ id: `e${n}`, at: new Date(n * 1000).toISOString() }));
    }
    const elapsed = Date.now() - started;
    db.close();

    // eslint-disable-next-line no-console
    console.log(`  ${ROWS} appends in ${elapsed}ms`);
    expect(elapsed).toBeLessThan(TARGET_MS);
  }, 60_000);
});
