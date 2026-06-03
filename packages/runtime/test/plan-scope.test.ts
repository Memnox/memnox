import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { LightMyRequestResponse } from 'fastify';
import { DECISION_EFFECT } from '@memnox/core';
import { buildServer, type MemnoxServer } from '../src/server';

const ADMIN = ['admin', 'token', 'value'].join('-');
const SESSION = 'session-1';

const STEPS = [
  { name: 'read', allows: ['repository.read', 'database.read'] },
  { name: 'write', allows: ['file.write'] },
];

describe('declared plan scope', () => {
  let dataDir: string;
  let server: MemnoxServer;
  let token: string;
  let otherToken: string;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'memnox-plan-'));
    server = await buildServer({
      dataDir,
      adminToken: ADMIN,
      enforcement: { default: 'enforce' },
    });
    token = await register('planner');
    otherToken = await register('intruder');
  });

  afterEach(async () => {
    await server.app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  async function register(name: string): Promise<string> {
    const response = await server.app.inject({
      method: 'POST',
      url: '/v1/agents',
      headers: { authorization: `Bearer ${ADMIN}` },
      payload: { name, kind: 'custom' },
    });
    return (response.json() as { token: string }).token;
  }

  const declare = (
    steps: unknown = STEPS,
    sessionId = SESSION,
    as = token,
  ): Promise<LightMyRequestResponse> =>
    server.app.inject({
      method: 'POST',
      url: '/v1/plans',
      headers: { authorization: `Bearer ${as}` },
      payload: { sessionId, steps },
    });

  const post = (url: string, as = token): Promise<LightMyRequestResponse> =>
    server.app.inject({
      method: 'POST',
      url,
      headers: { authorization: `Bearer ${as}` },
    });

  const check = (action: string, sessionId = SESSION): Promise<LightMyRequestResponse> =>
    server.app.inject({
      method: 'POST',
      url: '/v1/actions/check',
      headers: { authorization: `Bearer ${token}` },
      payload: { action, sessionId },
    });

  const effect = async (action: string): Promise<string> =>
    (await check(action)).json().effect;

  it('declares a plan and starts on its first step', async () => {
    const response = await declare();

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({ current: 0, sessionId: SESSION });
  });

  it('allows what the current step declared', async () => {
    await declare();

    expect(await effect('repository.read')).toBe(DECISION_EFFECT.ALLOW);
  });

  it('blocks an action the current step did not declare', async () => {
    await declare();

    expect(await effect('file.write')).toBe(DECISION_EFFECT.BLOCK);
  });

  // The point of step scoping: reaching step 2 must not carry step 1's grant.
  it('drops the previous step’s permissions on advance', async () => {
    const planId = (await declare()).json().id;
    expect(await effect('repository.read')).toBe(DECISION_EFFECT.ALLOW);

    await post(`/v1/plans/${planId}/advance`);

    expect(await effect('file.write')).toBe(DECISION_EFFECT.ALLOW);
    expect(await effect('repository.read')).toBe(DECISION_EFFECT.BLOCK);
  });

  it('closes the plan after the last step, allowing nothing', async () => {
    const planId = (await declare()).json().id;
    await post(`/v1/plans/${planId}/advance`);
    const closed = await post(`/v1/plans/${planId}/advance`);

    expect(closed.json().closedAt).toBeTruthy();
    expect(await effect('file.write')).toBe(DECISION_EFFECT.BLOCK);
    expect(await effect('repository.read')).toBe(DECISION_EFFECT.BLOCK);
  });

  it('allows nothing once explicitly closed', async () => {
    const planId = (await declare()).json().id;
    await post(`/v1/plans/${planId}/close`);

    expect(await effect('repository.read')).toBe(DECISION_EFFECT.BLOCK);
  });

  // Opting in is what turns scoping on; ordinary sessions must be untouched.
  it('leaves a session with no plan ungoverned', async () => {
    const response = await server.app.inject({
      method: 'POST',
      url: '/v1/actions/check',
      headers: { authorization: `Bearer ${token}` },
      payload: { action: 'file.write', sessionId: 'unplanned' },
    });

    expect(response.json().effect).toBe(DECISION_EFFECT.ALLOW);
  });

  it('scopes only the session that declared the plan', async () => {
    await declare();

    const other = await server.app.inject({
      method: 'POST',
      url: '/v1/actions/check',
      headers: { authorization: `Bearer ${token}` },
      payload: { action: 'file.write', sessionId: 'other-session' },
    });
    expect(other.json().effect).toBe(DECISION_EFFECT.ALLOW);
  });

  // A second open plan would let an agent pick whichever scope suits it.
  it('refuses a second open plan for one session', async () => {
    await declare();

    expect((await declare()).statusCode).toBe(409);
  });

  it('treats a step that declares nothing as granting nothing', async () => {
    await declare([{ name: 'idle', allows: [] }], 'empty-session');

    const response = await server.app.inject({
      method: 'POST',
      url: '/v1/actions/check',
      headers: { authorization: `Bearer ${token}` },
      payload: { action: 'repository.read', sessionId: 'empty-session' },
    });
    expect(response.json().effect).toBe(DECISION_EFFECT.BLOCK);
  });

  describe('ownership and validation', () => {
    it('keeps a plan private to its own agent', async () => {
      const planId = (await declare()).json().id;

      expect((await post(`/v1/plans/${planId}/advance`, otherToken)).statusCode).toBe(
        403,
      );
      const read = await server.app.inject({
        method: 'GET',
        url: `/v1/plans/${planId}`,
        headers: { authorization: `Bearer ${otherToken}` },
      });
      expect(read.statusCode).toBe(403);
    });

    it('rejects malformed steps', async () => {
      expect((await declare([], 's1')).statusCode).toBe(400);
      expect((await declare([{ name: 'x' }], 's2')).statusCode).toBe(400);
      expect((await declare([{ allows: ['a'] }], 's3')).statusCode).toBe(400);
      expect((await declare([{ name: 'x', allows: [1] }], 's4')).statusCode).toBe(400);
    });

    it('requires a session id', async () => {
      const response = await server.app.inject({
        method: 'POST',
        url: '/v1/plans',
        headers: { authorization: `Bearer ${token}` },
        payload: { steps: STEPS },
      });
      expect(response.statusCode).toBe(400);
    });

    it('rejects an unauthenticated caller and 404s an unknown plan', async () => {
      const anonymous = await server.app.inject({
        method: 'POST',
        url: '/v1/plans',
        payload: { sessionId: 'x', steps: STEPS },
      });
      expect(anonymous.statusCode).toBe(401);
      expect((await post('/v1/plans/nope/advance')).statusCode).toBe(404);
    });
  });
});
