import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AGENT_ROTATE_ACTION, type ActionEvent } from '@memnox/core';
import { buildServer, type MemnoxServer } from '../src/server';

describe('agent credential rotation', () => {
  let dataDir: string;
  let server: MemnoxServer;
  let agentId: string;
  let originalToken: string;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'memnox-rotate-'));
    server = await buildServer({ dataDir });
    const registration = await server.app.inject({
      method: 'POST',
      url: '/v1/agents',
      payload: { name: 'claude-code', kind: 'claude-code' },
    });
    const body = registration.json() as { agent: { id: string }; token: string };
    agentId = body.agent.id;
    originalToken = body.token;
  });

  afterEach(async () => {
    await server.app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const checkWith = (token: string) =>
    server.app.inject({
      method: 'POST',
      url: '/v1/actions/check',
      headers: { authorization: `Bearer ${token}` },
      payload: { action: 'code.read' },
    });

  const rotate = () =>
    server.app.inject({ method: 'POST', url: `/v1/agents/${agentId}/rotate` });

  it('issues a working new token', async () => {
    const response = await rotate();
    expect(response.statusCode).toBe(201);

    const { token } = response.json() as { token: string };
    expect(token).not.toBe(originalToken);
    expect((await checkWith(token)).json()).toMatchObject({ effect: 'allow' });
  });

  it('retires the old token immediately', async () => {
    expect((await checkWith(originalToken)).json()).toMatchObject({ effect: 'allow' });
    await rotate();
    expect((await checkWith(originalToken)).json()).toMatchObject({ effect: 'block' });
  });

  it('never returns the stored hash', async () => {
    const body = (await rotate()).json() as { agent: Record<string, unknown> };
    expect('tokenHash' in body.agent).toBe(false);
    expect(body.agent['rotatedAt']).toEqual(expect.any(String));
  });

  it('audits the rotation', async () => {
    await rotate();
    const events = (
      await server.app.inject({ method: 'GET', url: '/v1/audit' })
    ).json() as ActionEvent[];
    const rotation = events.find((event) => event.action === AGENT_ROTATE_ACTION);
    expect(rotation?.reason).toContain('rotated');
  });

  it('404s an unknown agent', async () => {
    const response = await server.app.inject({
      method: 'POST',
      url: '/v1/agents/does-not-exist/rotate',
    });
    expect(response.statusCode).toBe(404);
  });
});
