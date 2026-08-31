import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DECISION_EFFECT } from '@memnox/core';
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

describe('memnox server', () => {
  let dataDir: string;
  let server: MemnoxServer;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'memnox-test-'));
    const policyFile = join(dataDir, 'policies.yaml');
    await writeFile(policyFile, POLICY_YAML, 'utf8');
    server = await buildServer({ dataDir, policyFile });
  });

  afterEach(async () => {
    await server.app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  it('registers an agent, blocks a violation, and exposes the audit trail', async () => {
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
    expect(check.statusCode).toBe(200);
    expect((check.json() as { effect: string }).effect).toBe(DECISION_EFFECT.WITHHOLD);

    const audit = await server.app.inject({ method: 'GET', url: '/v1/audit' });
    const events = audit.json() as Array<{ action: string; effect: string }>;
    expect(events[0]?.action).toBe('database.delete');
    expect(events[0]?.effect).toBe(DECISION_EFFECT.WITHHOLD);
  });

  it('rejects checks without a bearer token', async () => {
    const check = await server.app.inject({
      method: 'POST',
      url: '/v1/actions/check',
      payload: { action: 'repository.read' },
    });
    expect(check.statusCode).toBe(401);
  });

  it('never exposes token hashes in the agent list', async () => {
    await server.app.inject({
      method: 'POST',
      url: '/v1/agents',
      payload: { name: 'claude-code' },
    });
    const list = await server.app.inject({ method: 'GET', url: '/v1/agents' });
    const agents = list.json() as Array<Record<string, unknown>>;
    expect(agents[0]?.['tokenHash']).toBeUndefined();
    expect(agents[0]?.['trustScore']).toBeUndefined();
  });

  it('accepts capabilities on registration and exposes them in the agent list', async () => {
    const registration = await server.app.inject({
      method: 'POST',
      url: '/v1/agents',
      payload: { name: 'reader', capabilities: ['repository.*', 'docs.read'] },
    });
    expect(registration.statusCode).toBe(201);

    const list = await server.app.inject({ method: 'GET', url: '/v1/agents' });
    const agents = list.json() as Array<{ capabilities?: string[] }>;
    expect(agents[0]?.capabilities).toEqual(['repository.*', 'docs.read']);
  });

  it('rejects malformed capabilities on registration', async () => {
    const registration = await server.app.inject({
      method: 'POST',
      url: '/v1/agents',
      payload: { name: 'reader', capabilities: ['ok', 42] },
    });
    expect(registration.statusCode).toBe(400);
  });

  it('guards admin routes when an admin token is configured', async () => {
    const secured = await buildServer({ dataDir, adminToken: 'admin-secret' });
    const denied = await secured.app.inject({ method: 'GET', url: '/v1/audit' });
    expect(denied.statusCode).toBe(401);

    const granted = await secured.app.inject({
      method: 'GET',
      url: '/v1/audit',
      headers: { authorization: 'Bearer admin-secret' },
    });
    expect(granted.statusCode).toBe(200);
    await secured.app.close();
  });
});
