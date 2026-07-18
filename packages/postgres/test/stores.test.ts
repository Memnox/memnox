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
// Reversible stand-in for the runtime's AesGcmCodec — proves the codec seam without a dependency cycle.
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
    stats: { allowed: 0, blocked: 0, approvalsRequested: 0 },
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
    enforcement: DECISION_ENFORCEMENT.BLOCK,
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
