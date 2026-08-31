import { beforeEach, describe, expect, it } from 'vitest';
import { newDb } from 'pg-mem';
import {
  APPROVAL_STATUS,
  DEFAULT_MIN_APPROVALS,
  DECISION_EFFECT,
  RISK_LEVEL,
  type ActionEvent,
  type AgentIdentity,
  type Approval,
} from '@memnox/core';
import { DECISION_ENFORCEMENT, type DecisionRecord } from '@memnox/memory';
import type { TextCodec } from '@memnox/core';
import { ensureRuntimeSchema } from '../src/schema';
import { PostgresApprovalStore } from '../src/postgres-approval-store';
import { PostgresAuditLog } from '../src/postgres-audit-log';
import { PostgresDecisionStore } from '../src/postgres-decision-store';
import { PostgresIdentityStore } from '../src/postgres-identity-store';
import type { SqlClient } from '../src/sql-client';

// Assembled at runtime so no credential-shaped literals exist in this file.
const TOKEN_HASH = ['deadbeef', 'cafe', '0123'].join('');
// Reversible stand-in for AesGcmCodec — the codec seam without a dependency cycle.
const BASE64_CODEC: TextCodec = {
  encode: (plaintext) => Buffer.from(plaintext, 'utf8').toString('base64'),
  decode: (stored) => Buffer.from(stored, 'base64').toString('utf8'),
};

function inMemorySql(): SqlClient {
  const { Pool } = newDb().adapters.createPg() as {
    Pool: new () => SqlClient;
  };
  return new Pool();
}

function agent(id: string): AgentIdentity {
  return {
    id,
    name: `agent-${id}`,
    kind: 'claude-code',
    status: 'active',
    tokenHash: `${TOKEN_HASH}-${id}`,
    createdAt: `2026-07-0${id.length}T00:00:00.000Z`,
    stats: { allowed: 0, withheld: 0, approvalsRequested: 0 },
  };
}

function decision(id: string, decidedAt: string): DecisionRecord {
  return {
    id,
    title: `Decision ${id}`,
    statement: 'no friday deploys',
    owner: 'ana',
    decidedAt,
    actions: ['deploy.production'],
    enforcement: DECISION_ENFORCEMENT.WITHHOLD,
  };
}

function approval(id: string, fingerprint: string): Approval {
  return {
    id,
    requestFingerprint: fingerprint,
    agentId: 'a1',
    action: 'deploy.production',
    approvers: [],
    minApprovals: DEFAULT_MIN_APPROVALS,
    grants: [],
    status: APPROVAL_STATUS.PENDING,
    createdAt: '2026-07-01T00:00:00.000Z',
  };
}

function auditEvent(id: string, occurredAt: string, agentId = 'a1'): ActionEvent {
  return {
    id,
    occurredAt,
    agentId,
    agentName: 'claude-code',
    action: 'file.read',
    effect: DECISION_EFFECT.ALLOW,
    riskLevel: RISK_LEVEL.LOW,
    matchedPolicies: [],
    advisories: [],
    reason: 'allowed',
  };
}

describe('postgres stores', () => {
  let sql: SqlClient;

  beforeEach(async () => {
    sql = inMemorySql();
    await ensureRuntimeSchema(sql);
  });

  it('schema bootstrap is idempotent', async () => {
    await ensureRuntimeSchema(sql);
    await ensureRuntimeSchema(sql);
  });

  // Only audit_events filters on org_id; the other three carried an index no query used.
  it('schema bootstrap sheds the org indexes nothing queries', async () => {
    const statements: string[] = [];
    const recorder: SqlClient = {
      query: async (text: string) => {
        statements.push(text);
        return { rows: [] };
      },
      end: async () => undefined,
    };

    await ensureRuntimeSchema(recorder);
    const issued = statements.join('\n');

    expect(issued).toContain('DROP INDEX IF EXISTS agents_org');
    expect(issued).toContain('DROP INDEX IF EXISTS decisions_org_decided_at');
    expect(issued).toContain('DROP INDEX IF EXISTS approvals_org');
    expect(issued).not.toContain('CREATE INDEX IF NOT EXISTS approvals_org');
    // The one org index a query actually uses stays.
    expect(issued).toContain('CREATE INDEX IF NOT EXISTS audit_events_org_time');
  });

  it('identity store: upsert, lookup by id and token hash, ordered list', async () => {
    const store = new PostgresIdentityStore(sql);
    await store.save(agent('a1'));
    await store.save(agent('b22'));
    await store.save({ ...agent('a1'), name: 'renamed' });

    expect((await store.findById('a1'))?.name).toBe('renamed');
    expect((await store.findByTokenHash(`${TOKEN_HASH}-b22`))?.id).toBe('b22');
    expect(await store.findByTokenHash('unknown')).toBeNull();
    expect((await store.list()).map((entry) => entry.id)).toEqual(['a1', 'b22']);
  });

  it('decision store: upsert, chronological list, remove', async () => {
    const store = new PostgresDecisionStore(sql);
    await store.save(decision('d2', '2026-07-02T00:00:00.000Z'));
    await store.save(decision('d1', '2026-07-01T00:00:00.000Z'));

    expect((await store.list()).map((entry) => entry.id)).toEqual(['d1', 'd2']);
    expect(await store.remove('d1')).toBe(true);
    expect(await store.remove('d1')).toBe(false);
    expect(await store.list()).toHaveLength(1);
  });

  it('approval store: pending fingerprint lookup ignores resolved approvals', async () => {
    const store = new PostgresApprovalStore(sql);
    await store.save(approval('ap1', 'fp-1'));
    await store.save({
      ...approval('ap2', 'fp-1'),
      status: APPROVAL_STATUS.APPROVED,
    });

    expect((await store.findPendingByFingerprint('fp-1'))?.id).toBe('ap1');
    expect(await store.findPendingByFingerprint('fp-other')).toBeNull();
    expect(await store.listByStatus(APPROVAL_STATUS.APPROVED)).toHaveLength(1);
    expect((await store.findById('ap2'))?.status).toBe(APPROVAL_STATUS.APPROVED);
  });

  it('approval store: prunes resolved approvals and keeps pending ones', async () => {
    const store = new PostgresApprovalStore(sql);
    await store.save({ ...approval('ap1', 'fp-1'), status: APPROVAL_STATUS.APPROVED });
    await store.save({ ...approval('ap2', 'fp-2'), status: APPROVAL_STATUS.EXPIRED });
    // Old and unanswered — a decision still owed, so retention leaves it alone.
    await store.save(approval('ap3', 'fp-3'));
    await store.save({
      ...approval('ap4', 'fp-4'),
      createdAt: '2026-08-01T00:00:00.000Z',
      status: APPROVAL_STATUS.DENIED,
    });

    expect(await store.pruneResolvedBefore('2026-07-15T00:00:00.000Z')).toBe(2);
    expect(await store.findById('ap1')).toBeNull();
    expect(await store.findById('ap2')).toBeNull();
    expect((await store.findById('ap3'))?.status).toBe(APPROVAL_STATUS.PENDING);
    expect((await store.findById('ap4'))?.status).toBe(APPROVAL_STATUS.DENIED);
  });

  it('audit log: newest-first recent, chronological filtered query', async () => {
    const log = new PostgresAuditLog(sql);
    await log.append(auditEvent('e1', '2026-07-01T00:00:00.000Z'));
    await log.append(auditEvent('e2', '2026-07-02T00:00:00.000Z', 'a2'));
    await log.append(auditEvent('e3', '2026-07-03T00:00:00.000Z'));

    expect((await log.recent(2)).map((entry) => entry.id)).toEqual(['e3', 'e2']);
    expect((await log.query({ agentId: 'a1' })).map((entry) => entry.id)).toEqual([
      'e1',
      'e3',
    ]);
    expect(
      (
        await log.query({
          from: '2026-07-02T00:00:00.000Z',
          to: '2026-07-02T23:59:59.000Z',
        })
      ).map((entry) => entry.id),
    ).toEqual(['e2']);
  });

  it('filters the audit timeline by project across repositories', async () => {
    const log = new PostgresAuditLog(sql);
    const scoped = (id: string, projectId?: string): ActionEvent => ({
      ...auditEvent(id, `2026-07-0${id.slice(1)}T00:00:00.000Z`),
      projectId,
    });
    await log.append(scoped('e1', 'acme-checkout')); // web repo
    await log.append(scoped('e2', 'acme-checkout')); // api repo
    await log.append(scoped('e3', 'billing-service'));
    await log.append(scoped('e4'));

    expect(
      (await log.query({ projectId: 'acme-checkout' })).map((entry) => entry.id),
    ).toEqual(['e1', 'e2']);
    expect(
      (await log.query({ projectId: 'billing-service' })).map((entry) => entry.id),
    ).toEqual(['e3']);
    expect((await log.query({})).map((entry) => entry.id)).toHaveLength(4);
  });

  it('encodes records at rest while query columns stay searchable', async () => {
    const store = new PostgresIdentityStore(sql, BASE64_CODEC);
    await store.save(agent('secret'));

    const { rows } = await sql.query(`SELECT record FROM agents`);
    expect(String(rows[0]?.['record'])).not.toContain('agent-secret');
    expect((await store.findByTokenHash(`${TOKEN_HASH}-secret`))?.name).toBe(
      'agent-secret',
    );
  });
});
