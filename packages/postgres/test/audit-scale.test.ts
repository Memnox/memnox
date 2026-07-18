import { beforeEach, describe, expect, it } from 'vitest';
import { newDb } from 'pg-mem';
import {
  AUDIT_CHAIN_BREAK,
  DECISION_EFFECT,
  RISK_LEVEL,
  type ActionEvent,
} from '@memnox/core';
import { ensureRuntimeSchema } from '../src/schema';
import { PostgresAuditLog } from '../src/postgres-audit-log';
import type { SqlClient, SqlRow } from '../src/sql-client';

/** Records every statement so the test can assert what was pushed into SQL. */
class RecordingSql implements SqlClient {
  readonly statements: Array<{ text: string; params: unknown[] }> = [];

  constructor(private readonly inner: SqlClient) {}

  async query(text: string, params: unknown[] = []): Promise<{ rows: SqlRow[] }> {
    this.statements.push({ text, params });
    return this.inner.query(text, params);
  }

  async end(): Promise<void> {
    await this.inner.end();
  }

  lastMatching(fragment: string): { text: string; params: unknown[] } | undefined {
    return [...this.statements].reverse().find((entry) => entry.text.includes(fragment));
  }
}

function inMemorySql(): SqlClient {
  const { Pool } = newDb().adapters.createPg() as { Pool: new () => SqlClient };
  return new Pool();
}

function auditEvent(
  id: string,
  occurredAt: string,
  overrides: Partial<ActionEvent> = {},
): ActionEvent {
  return {
    id,
    occurredAt,
    agentId: 'a1',
    agentName: 'claude-code',
    action: 'file.read',
    effect: DECISION_EFFECT.ALLOW,
    riskLevel: RISK_LEVEL.LOW,
    matchedPolicies: [],
    advisories: [],
    reason: 'allowed',
    ...overrides,
  };
}

const DAY = (day: number): string =>
  `2026-07-${String(day).padStart(2, '0')}T00:00:00.000Z`;

describe('postgres audit log at scale', () => {
  let sql: RecordingSql;
  let log: PostgresAuditLog;

  beforeEach(async () => {
    sql = new RecordingSql(inMemorySql());
    await ensureRuntimeSchema(sql);
    log = new PostgresAuditLog(sql);
  });

  it('pushes ORDER BY ... DESC LIMIT into SQL instead of truncating in memory', async () => {
    for (let day = 1; day <= 5; day += 1)
      await log.append(auditEvent(`e${day}`, DAY(day)));

    const events = await log.query({ agentId: 'a1', limit: 2 });

    // The newest two, handed back in chronological order.
    expect(events.map((event) => event.id)).toEqual(['e4', 'e5']);
    const statement = sql.lastMatching('SELECT record FROM audit_events WHERE');
    expect(statement?.text).toContain('ORDER BY occurred_at DESC, seq DESC LIMIT $2');
    expect(statement?.params).toEqual(['a1', 2]);
  });

  it('keeps an unbounded query chronological and free of a LIMIT clause', async () => {
    for (let day = 1; day <= 3; day += 1)
      await log.append(auditEvent(`e${day}`, DAY(day)));

    const events = await log.query({ agentId: 'a1' });

    expect(events.map((event) => event.id)).toEqual(['e1', 'e2', 'e3']);
    expect(sql.lastMatching('SELECT record FROM audit_events WHERE')?.text).not.toContain(
      'LIMIT',
    );
  });

  it('prunes in batches and reports how many events went', async () => {
    for (let day = 1; day <= 6; day += 1)
      await log.append(auditEvent(`e${day}`, DAY(day)));

    expect(await log.pruneBefore(DAY(4))).toBe(3);
    expect((await log.recent(10)).map((event) => event.id)).toEqual(['e6', 'e5', 'e4']);
    // Every prune statement is bounded — a retention sweep never rewrites the whole table at once.
    expect(sql.lastMatching('DELETE FROM audit_events')?.text).toContain('LIMIT $2');
    expect(await log.pruneBefore(DAY(4))).toBe(0);
  });

  it('hash-chains appends and verifies them; a pruned prefix still verifies', async () => {
    for (let day = 1; day <= 4; day += 1)
      await log.append(auditEvent(`e${day}`, DAY(day)));

    const stored = await log.query({});
    expect(stored[0]?.prevHash).toBe('0'.repeat(64));
    expect(stored[1]?.prevHash).toBe(stored[0]?.hash);
    expect(await log.verifyChain()).toEqual({
      valid: true,
      checked: 4,
      brokenAtIndex: -1,
    });

    await log.pruneBefore(DAY(3));
    expect((await log.verifyChain()).valid).toBe(true);
  });

  it('reports the index of a record edited behind the log', async () => {
    for (let day = 1; day <= 3; day += 1)
      await log.append(auditEvent(`e${day}`, DAY(day)));
    const tampered = JSON.stringify({
      ...auditEvent('e2', DAY(2), { reason: 'nothing to see here' }),
      prevHash: (await log.query({}))[0]?.hash,
      hash: (await log.query({}))[1]?.hash,
    });
    await sql.query(`UPDATE audit_events SET record = $1 WHERE id = $2`, [
      tampered,
      'e2',
    ]);

    const result = await log.verifyChain();
    expect(result.valid).toBe(false);
    expect(result.brokenAtIndex).toBe(1);
    expect(result.brokenEventId).toBe('e2');
    expect(result.brokenReason).toBe(AUDIT_CHAIN_BREAK.CONTENT_MISMATCH);
  });

  it('round-trips orgId into its own column and filters on it', async () => {
    await log.append(auditEvent('e1', DAY(1), { orgId: 'acme' }));
    await log.append(auditEvent('e2', DAY(2), { orgId: 'globex' }));
    await log.append(auditEvent('e3', DAY(3)));

    const { rows } = await sql.query(`SELECT id FROM audit_events WHERE org_id = $1`, [
      'acme',
    ]);
    expect(rows.map((row) => row['id'])).toEqual(['e1']);
    expect((await log.query({ orgId: 'globex' })).map((event) => event.id)).toEqual([
      'e2',
    ]);
    // A single-tenant event carries no org and is never claimed by one.
    expect((await log.query({})).map((event) => event.orgId)).toEqual([
      'acme',
      'globex',
      undefined,
    ]);
  });
});
