import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DECISION_EFFECT } from '@memnox/core';
import type { LightMyRequestResponse } from 'fastify';
import { buildServer, type MemnoxServer } from '../src/server';

const POLICY_YAML = `
version: 1
policies:
  - name: no-shell
    match:
      actions: ["shell.execute"]
    decision:
      effect: block
      reason: No shell for agents
`;

const ADMIN = ['admin', 'token', 'value'].join('-');

/**
 * The mode used to be a startup flag, which left a control plane able to see
 * drift and unable to correct it. These prove it is now a live setting.
 */
describe('PUT /v1/enforcement', () => {
  let dataDir: string;
  let server: MemnoxServer;
  let agentToken: string;

  const start = async (): Promise<void> => {
    server = await buildServer({
      dataDir,
      policyFile: join(dataDir, 'policies.yaml'),
      adminToken: ADMIN,
      enforcement: { default: 'monitor' },
    });
    const registration = await server.app.inject({
      method: 'POST',
      url: '/v1/agents',
      headers: { authorization: `Bearer ${ADMIN}` },
      payload: { name: 'claude-code', kind: 'claude-code' },
    });
    agentToken = (registration.json() as { token: string }).token;
  };

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'memnox-enforcement-'));
    await writeFile(join(dataDir, 'policies.yaml'), POLICY_YAML, 'utf8');
    await start();
  });

  afterEach(async () => {
    await server.app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const put = (
    payload: Record<string, unknown>,
    token = ADMIN,
  ): Promise<LightMyRequestResponse> =>
    server.app.inject({
      method: 'PUT',
      url: '/v1/enforcement',
      headers: { authorization: `Bearer ${token}` },
      payload,
    });

  const check = (environment: string): Promise<LightMyRequestResponse> =>
    server.app.inject({
      method: 'POST',
      url: '/v1/actions/check',
      headers: { authorization: `Bearer ${agentToken}` },
      payload: { action: 'shell.execute', environment },
    });

  it('changes what the runtime actually withholds, without a restart', async () => {
    // Monitor records the verdict without applying it.
    expect((await check('production')).json()).toMatchObject({
      effect: DECISION_EFFECT.ALLOW,
      withheldEffect: DECISION_EFFECT.BLOCK,
    });

    const response = await put({ environments: { production: 'enforce' } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ applied: true });

    expect((await check('production')).json()).toMatchObject({
      effect: DECISION_EFFECT.BLOCK,
    });
  });

  it('leaves environments it was not told about alone', async () => {
    await put({ environments: { production: 'enforce' } });

    // staging still takes the default the process started with.
    expect((await check('staging')).json()).toMatchObject({
      effect: DECISION_EFFECT.ALLOW,
      withheldEffect: DECISION_EFFECT.BLOCK,
    });
    expect(
      (
        await server.app.inject({
          method: 'GET',
          url: '/v1/enforcement',
          headers: { authorization: `Bearer ${ADMIN}` },
        })
      ).json(),
    ).toEqual({
      default: 'monitor',
      environments: { production: 'enforce' },
    });
  });

  it('survives a restart, so a mode is not silently reverted', async () => {
    await put({ environments: { production: 'enforce' } });
    await server.app.close();

    // Restarted with no flag at all: the stored map is what is left to go on.
    server = await buildServer({
      dataDir,
      policyFile: join(dataDir, 'policies.yaml'),
      adminToken: ADMIN,
    });
    const registration = await server.app.inject({
      method: 'POST',
      url: '/v1/agents',
      headers: { authorization: `Bearer ${ADMIN}` },
      payload: { name: 'claude-code', kind: 'claude-code' },
    });
    agentToken = (registration.json() as { token: string }).token;

    expect((await check('production')).json()).toMatchObject({
      effect: DECISION_EFFECT.BLOCK,
    });
  });

  it('refuses a mode it does not know, and keeps applying what it had', async () => {
    const refused = await put({ environments: { production: 'lenient' } });
    expect(refused.statusCode).toBe(400);

    expect((await check('production')).json()).toMatchObject({
      effect: DECISION_EFFECT.ALLOW,
      withheldEffect: DECISION_EFFECT.BLOCK,
    });
  });

  it('records the change in the audit chain, so weakening it leaves a trace', async () => {
    await put({ environments: { production: 'off' } });

    const audit = await server.app.inject({
      method: 'GET',
      url: '/v1/audit',
      headers: { authorization: `Bearer ${ADMIN}` },
    });
    const events = audit.json() as Array<{
      action: string;
      reason: string;
      riskLevel: string;
    }>;
    const change = events.find((event) => event.action === 'governance.enforcement');

    expect(change).toBeDefined();
    expect(change?.reason).toContain('production=off');
    // Turning governance down is the case worth finding in a chain later.
    expect(change?.riskLevel).toBe('high');
  });

  it('needs an admin token', async () => {
    const refused = await put({ environments: { production: 'enforce' } }, 'viewer');
    expect(refused.statusCode).toBe(401);
  });
});
