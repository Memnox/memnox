import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DECISION_EFFECT } from '@memnox/core';
import { buildServer, type MemnoxServer } from '../src/server';

const ADMIN = ['admin', 'token', 'value'].join('-');

const POLICIES = `
version: 1
policies:
  - name: production-database-protection
    match:
      actions: ["database.delete"]
      environments: ["production"]
    decision:
      effect: withhold
      reason: No AI database deletion
  - name: deploy-approval
    match:
      actions: ["deploy.*"]
      environments: ["production"]
    decision:
      effect: escalate
      approvers: ["eng-lead"]
`;

/** Every advisor and store on the decision path must work with no network at all. */
describe('air-gapped operation', () => {
  let dataDir: string;
  let server: MemnoxServer;
  let token: string;
  let attempted: string[];
  let realFetch: typeof globalThis.fetch;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'memnox-airgap-'));
    const policyFile = join(dataDir, 'policies.yaml');
    await writeFile(policyFile, POLICIES, 'utf8');

    server = await buildServer({
      dataDir,
      policyFile,
      adminToken: ADMIN,
      enforcement: { default: 'enforce' },
      // Every guard on: the point is that none of them reaches out.
      behaviorGuard: true,
      memoryEnabled: true,
      shellGuard: true,
      sessionTokenBudget: 1_000,
    });
    const registration = await server.app.inject({
      method: 'POST',
      url: '/v1/agents',
      headers: { authorization: `Bearer ${ADMIN}` },
      payload: { name: 'claude-code', kind: 'claude-code' },
    });
    token = (registration.json() as { token: string }).token;

    // Installed after startup so only the decision path is under scrutiny.
    attempted = [];
    realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: unknown) => {
      attempted.push(String(input));
      throw new Error('network is unavailable in an air-gapped deployment');
    }) as unknown as typeof globalThis.fetch;
  });

  afterEach(async () => {
    globalThis.fetch = realFetch;
    await server.app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const decide = (payload: Record<string, unknown>) =>
    server.app.inject({
      method: 'POST',
      url: '/v1/actions/check',
      headers: { authorization: `Bearer ${token}` },
      payload,
    });

  it('blocks without touching the network', async () => {
    const response = await decide({
      action: 'database.delete',
      target: 'production.users',
      environment: 'production',
      sessionId: 's1',
    });

    expect(response.json().effect).toBe(DECISION_EFFECT.WITHHOLD);
    expect(attempted).toEqual([]);
  });

  it('allows without touching the network', async () => {
    const response = await decide({ action: 'repository.read', sessionId: 's1' });

    expect(response.json().effect).toBe(DECISION_EFFECT.ALLOW);
    expect(attempted).toEqual([]);
  });

  it('raises an approval without touching the network', async () => {
    const response = await decide({
      action: 'deploy.service',
      environment: 'production',
      sessionId: 's1',
    });

    expect(response.json().effect).toBe(DECISION_EFFECT.ESCALATE);
    expect(attempted).toEqual([]);
  });

  it('reads past shell indirection without touching the network', async () => {
    const response = await decide({
      action: 'shell.execute',
      target: `bash -c "rm -rf /data"`,
      sessionId: 's1',
    });

    expect(response.json().effect).toBe(DECISION_EFFECT.WITHHOLD);
    expect(attempted).toEqual([]);
  });

  it('serves policies, audit, and metrics offline', async () => {
    for (const url of ['/v1/policies', '/v1/audit?limit=5', '/v1/metrics']) {
      const response = await server.app.inject({
        method: 'GET',
        url,
        headers: { authorization: `Bearer ${ADMIN}` },
      });
      expect(response.statusCode).toBe(200);
    }
    expect(attempted).toEqual([]);
  });

  it('verifies the audit chain offline', async () => {
    await decide({ action: 'repository.read', sessionId: 's1' });

    const response = await server.app.inject({
      method: 'GET',
      url: '/v1/audit/verify',
      headers: { authorization: `Bearer ${ADMIN}` },
    });

    expect(response.json().valid).toBe(true);
    expect(attempted).toEqual([]);
  });

  it('stays deterministic across a hundred decisions with no network', async () => {
    const effects = new Set<string>();
    for (let n = 0; n < 100; n += 1) {
      const response = await decide({
        action: 'database.delete',
        environment: 'production',
        sessionId: `bulk-${n}`,
      });
      effects.add(response.json().effect);
    }

    expect([...effects]).toEqual([DECISION_EFFECT.WITHHOLD]);
    expect(attempted).toEqual([]);
  });
});
