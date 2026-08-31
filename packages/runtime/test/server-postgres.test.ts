import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { newDb } from 'pg-mem';
import { DECISION_EFFECT } from '@memnox/core';
import type { SqlClient } from '@memnox/postgres';
import { buildServer, type MemnoxServer } from '../src/server';

const POLICY_YAML = `
version: 1
policies:
  - name: production-database-protection
    match:
      actions: ["database.delete"]
      environments: ["production"]
    decision:
      effect: withhold
      reason: No AI database deletion
`;

describe('server on postgres stores', () => {
  let dataDir: string;
  let server: MemnoxServer;
  let sql: SqlClient;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'memnox-pg-'));
    const policyFile = join(dataDir, 'policies.yaml');
    await writeFile(policyFile, POLICY_YAML, 'utf8');
    const { Pool } = newDb().adapters.createPg() as { Pool: new () => SqlClient };
    sql = new Pool();
    server = await buildServer({ dataDir, policyFile }, { sql });
  });

  afterEach(async () => {
    await server.app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  it('runs the full loop — register, block, audit — against SQL storage', async () => {
    const registration = await server.app.inject({
      method: 'POST',
      url: '/v1/agents',
      payload: { name: 'claude-code', kind: 'claude-code' },
    });
    expect(registration.statusCode).toBe(201);
    const { token } = registration.json() as { token: string };

    const check = await server.app.inject({
      method: 'POST',
      url: '/v1/actions/check',
      headers: { authorization: `Bearer ${token}` },
      payload: { action: 'database.delete', target: 'users', environment: 'production' },
    });
    expect((check.json() as { effect: string }).effect).toBe(DECISION_EFFECT.WITHHOLD);

    const audit = await server.app.inject({ method: 'GET', url: '/v1/audit' });
    const events = audit.json() as Array<{ action: string; effect: string }>;
    expect(events[0]?.action).toBe('database.delete');

    const stored = await sql.query('SELECT id FROM audit_events');
    expect(stored.rows).toHaveLength(1);
    const agents = await sql.query('SELECT id FROM agents');
    expect(agents.rows).toHaveLength(1);
  });

  it('agents survive across server rebuilds — the point of shared storage', async () => {
    const registration = await server.app.inject({
      method: 'POST',
      url: '/v1/agents',
      payload: { name: 'persistent-agent', kind: 'custom' },
    });
    const { token } = registration.json() as { token: string };
    await server.app.close();

    server = await buildServer(
      { dataDir, policyFile: join(dataDir, 'policies.yaml') },
      { sql },
    );
    const check = await server.app.inject({
      method: 'POST',
      url: '/v1/actions/check',
      headers: { authorization: `Bearer ${token}` },
      payload: { action: 'file.read' },
    });
    expect(check.statusCode).toBe(200);
  });
});
