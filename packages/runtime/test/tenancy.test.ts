import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ActionEvent, AuditChainVerification } from '@memnox/core';
import { buildServer, type MemnoxServer } from '../src/server';

const POLICY_YAML = `
version: 1
policies:
  - name: allow-reads
    match:
      actions: ["file.read"]
    decision:
      effect: allow
      reason: Reads are safe
`;

describe('org isolation and audit verification over HTTP', () => {
  let dataDir: string;
  let server: MemnoxServer;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'memnox-tenancy-'));
    const policyFile = join(dataDir, 'policies.yaml');
    await writeFile(policyFile, POLICY_YAML, 'utf8');
    server = await buildServer({ dataDir, policyFile });
  });

  afterEach(async () => {
    await server.app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  async function registerAgent(name: string, orgId?: string): Promise<string> {
    const response = await server.app.inject({
      method: 'POST',
      url: '/v1/agents',
      payload: { name, kind: 'claude-code', orgId },
    });
    return (response.json() as { token: string }).token;
  }

  async function check(token: string): Promise<void> {
    await server.app.inject({
      method: 'POST',
      url: '/v1/actions/check',
      headers: { authorization: `Bearer ${token}` },
      payload: { action: 'file.read', target: 'README.md' },
    });
  }

  it('stamps the agent org onto its audit events and filters by it', async () => {
    await check(await registerAgent('acme-agent', 'acme'));
    await check(await registerAgent('globex-agent', 'globex'));
    await check(await registerAgent('solo-agent'));

    const acme = await server.app.inject({ method: 'GET', url: '/v1/audit?org=acme' });
    const acmeEvents = acme.json() as ActionEvent[];
    expect(acmeEvents).toHaveLength(1);
    expect(acmeEvents[0]?.agentName).toBe('acme-agent');

    const all = await server.app.inject({ method: 'GET', url: '/v1/audit' });
    expect(all.json() as ActionEvent[]).toHaveLength(3);
  });

  it('leaves a single-tenant deployment untouched', async () => {
    await check(await registerAgent('solo-agent'));

    const events = (
      await server.app.inject({ method: 'GET', url: '/v1/audit' })
    ).json() as ActionEvent[];
    expect(events[0]?.orgId).toBeUndefined();
    expect(
      (
        (
          await server.app.inject({ method: 'GET', url: '/v1/audit?org=acme' })
        ).json() as ActionEvent[]
      ).length,
    ).toBe(0);
  });

  it('reports an intact chain from GET /v1/audit/verify', async () => {
    const token = await registerAgent('claude-code');
    await check(token);
    await check(token);

    const response = await server.app.inject({ method: 'GET', url: '/v1/audit/verify' });
    const result = response.json() as AuditChainVerification;
    expect(response.statusCode).toBe(200);
    expect(result.valid).toBe(true);
    expect(result.checked).toBe(2);
  });
});
