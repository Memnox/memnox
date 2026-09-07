import Database from 'better-sqlite3';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SqliteEventStore, databasePathFor } from '../src/event/sqlite-store';
import { EVENT_SCHEMA_VERSION, type MemnoxEvent } from '../src/event/event';

const home = (): Promise<string> => mkdtemp(join(tmpdir(), 'memnox-db-'));

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

async function store(): Promise<SqliteEventStore> {
  return SqliteEventStore.forHome(await home());
}

describe('the event store', () => {
  it('creates its file and survives being opened twice', async () => {
    const dir = await home();
    SqliteEventStore.forHome(dir).close();
    const second = SqliteEventStore.forHome(dir);
    expect(await second.count()).toBe(0);
    expect(databasePathFor(dir)).toContain('memnox.db');
    second.close();
  });

  it('round-trips every field, including the rule and the alternative', async () => {
    const db = await store();
    const original = event({
      principal: 'tresor',
      target: 'memnox/runtime#41',
      shadowEffect: 'allow',
      rule: { name: 'no-merge-on-friday', layer: 'project', file: 'p.yaml', line: 12 },
      alternative: { action: 'git.push', resource: 'a branch', note: 'open a PR' },
      policyHash: 'abc123',
      argsDigest: 'deadbeef',
      execution: 'blocked',
      exitCode: 1,
      durationMs: 42,
      outputDigest: 'cafe',
    });
    await db.append(original);

    const [read] = await db.query({});
    expect(read).toEqual(original);
    db.close();
  });

  it('ignores a resend rather than writing a second row', async () => {
    const db = await store();
    await db.append(event());
    await db.append(event({ reason: 'changed my mind' }));

    expect(await db.count()).toBe(1);
    expect((await db.query({}))[0]?.reason).toBe('production is frozen');
    db.close();
  });

  it('refuses to rewrite a row, because the record is the past and not a claim about it', async () => {
    const db = await store();
    await db.append(event());
    // Reaching past the sink is exactly what the trigger exists to stop.
    expect(() =>
      (
        db as unknown as { db: { prepare(sql: string): { run(...a: unknown[]): void } } }
      ).db
        .prepare('UPDATE events SET reason = ? WHERE id = ?')
        .run('rewritten', 'evt_1'),
    ).toThrow(/append-only/);
    db.close();
  });

  it('lets a held call record who released it, and only once', async () => {
    const db = await store();
    await db.append(event({ effect: 'ask' }));

    await db.recordAuthorization('evt_1', 'tresor');
    expect((await db.query({}))[0]?.authorizedBy).toBe('tresor');

    await db.recordAuthorization('evt_1', 'somebody-else');
    expect((await db.query({}))[0]?.authorizedBy).toBe('tresor');
    db.close();
  });

  it('filters by session, agent, surface, effect and time', async () => {
    const db = await store();
    await db.append(event({ id: 'a', at: '2026-09-01T00:00:00.000Z', effect: 'allow' }));
    await db.append(event({ id: 'b', at: '2026-09-02T00:00:00.000Z', surface: 'shell' }));
    await db.append(
      event({ id: 'c', at: '2026-09-03T00:00:00.000Z', sessionId: 'ses_2' }),
    );

    expect((await db.query({ effects: ['deny'] })).map((e) => e.id)).toEqual(['b', 'c']);
    expect((await db.query({ surface: 'shell' })).map((e) => e.id)).toEqual(['b']);
    expect((await db.query({ sessionId: 'ses_2' })).map((e) => e.id)).toEqual(['c']);
    expect(
      (await db.query({ since: '2026-09-02T00:00:00.000Z' })).map((e) => e.id),
    ).toEqual(['b', 'c']);
    db.close();
  });

  it('returns the most recent under a limit, still in chronological order', async () => {
    const db = await store();
    for (const n of [1, 2, 3, 4, 5]) {
      await db.append(event({ id: `e${n}`, at: `2026-09-0${n}T00:00:00.000Z` }));
    }
    expect((await db.query({ limit: 2 })).map((e) => e.id)).toEqual(['e4', 'e5']);
    db.close();
  });

  /**
   * Ten thousand rows, and the setting that makes ten thousand rows cheap.
   *
   * This used to assert a wall-clock bound, which measures the machine: a correct
   * store on a loaded laptop failed the suite and taught everybody to re-run it. What
   * actually decides the throughput is the journal mode — one fsync per commit against
   * a shared write-ahead log — so that is what is asserted here. The number itself
   * lives in `pnpm bench`, where a slow answer means something.
   */
  it('holds ten thousand events, on a journal built for concurrent writers', async () => {
    const dir = await home();
    const db = SqliteEventStore.forHome(dir);
    for (let n = 0; n < 10_000; n += 1) {
      await db.append(event({ id: `e${n}`, at: new Date(n * 1000).toISOString() }));
    }
    expect(await db.count()).toBe(10_000);
    db.close();

    // Read back from the file: WAL is persistent, so this is what any writer will get.
    const opened = new Database(databasePathFor(dir), { readonly: true });
    expect(String(opened.pragma('journal_mode', { simple: true })).toLowerCase()).toBe(
      'wal',
    );
    opened.close();
  }, 60_000);

  it('prunes by age and reports how many went', async () => {
    const db = await store();
    await db.append(event({ id: 'old', at: '2026-01-01T00:00:00.000Z' }));
    await db.append(event({ id: 'new', at: '2026-09-05T00:00:00.000Z' }));

    expect(await db.pruneBefore('2026-06-01T00:00:00.000Z')).toBe(1);
    expect((await db.query({})).map((e) => e.id)).toEqual(['new']);
    db.close();
  });

  it('keeps the rules that were in force, so why reads them back', async () => {
    const db = await store();
    await db.recordPolicyVersion('abc123', '2026-09-05T00:00:00.000Z', 'policies: []');
    expect(await db.policyVersion('abc123')).toBe('policies: []');
    expect(await db.policyVersion('nothing')).toBeNull();
    db.close();
  });
});
