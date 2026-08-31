import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { DECISION_EFFECT } from '@memnox/core';
import type { LightMyRequestResponse } from 'fastify';
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

const REPLACEMENT = {
  version: 1,
  policies: [
    {
      name: 'shell-block',
      match: { actions: ['shell.execute'] },
      decision: { effect: DECISION_EFFECT.WITHHOLD, reason: 'No shell for agents' },
    },
  ],
};

const ADMIN = ['admin', 'token', 'value'].join('-');

describe('PUT /v1/policies', () => {
  let dataDir: string;
  let policyFile: string;
  let server: MemnoxServer;
  let agentToken: string;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'memnox-policy-write-'));
    policyFile = join(dataDir, 'policies.yaml');
    await writeFile(policyFile, POLICY_YAML, 'utf8');
    server = await buildServer({
      dataDir,
      policyFile,
      adminToken: ADMIN,
      enforcement: { default: 'enforce' },
    });
    const registration = await server.app.inject({
      method: 'POST',
      url: '/v1/agents',
      headers: { authorization: `Bearer ${ADMIN}` },
      payload: { name: 'claude-code', kind: 'claude-code' },
    });
    agentToken = (registration.json() as { token: string }).token;
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
      url: '/v1/policies',
      headers: { authorization: `Bearer ${token}` },
      payload,
    });

  const check = (action: string, environment?: string): Promise<LightMyRequestResponse> =>
    server.app.inject({
      method: 'POST',
      url: '/v1/actions/check',
      headers: { authorization: `Bearer ${agentToken}` },
      payload: { action, environment },
    });

  it('replaces the rule set and reports the new version', async () => {
    const response = await put(REPLACEMENT);

    expect(response.statusCode).toBe(200);
    const body = response.json() as { applied: boolean; policyNames: string[] };
    expect(body.applied).toBe(true);
    expect(body.policyNames).toEqual(['shell-block']);
  });

  it('changes what the runtime decides, immediately', async () => {
    expect((await check('shell.execute')).json()).toMatchObject({
      effect: DECISION_EFFECT.ALLOW,
    });

    await put(REPLACEMENT);

    expect((await check('shell.execute')).json()).toMatchObject({
      effect: DECISION_EFFECT.WITHHOLD,
    });
  });

  it('retires the rules it replaced', async () => {
    await put(REPLACEMENT);

    expect((await check('database.delete', 'production')).json()).toMatchObject({
      effect: DECISION_EFFECT.ALLOW,
    });
  });

  // Without this the rules vanish on restart and the diff stops being the record.
  it('persists to the policy file, not just memory', async () => {
    await put(REPLACEMENT);

    const written = parse(await readFile(policyFile, 'utf8')) as {
      policies: Array<{ name: string }>;
    };
    expect(written.policies.map((policy) => policy.name)).toEqual(['shell-block']);
  });

  it('survives a restart from the same file', async () => {
    await put(REPLACEMENT);
    await server.app.close();
    server = await buildServer({
      dataDir,
      policyFile,
      adminToken: ADMIN,
      enforcement: { default: 'enforce' },
    });

    const response = await server.app.inject({
      method: 'GET',
      url: '/v1/policies',
      headers: { authorization: `Bearer ${ADMIN}` },
    });
    expect((response.json() as { policyNames: string[] }).policyNames).toEqual([
      'shell-block',
    ]);
  });

  describe('rejection', () => {
    it('rejects an invalid document without changing anything', async () => {
      const response = await put({ version: 1, policies: [{ name: 'broken' }] });

      expect(response.statusCode).toBe(400);
      expect((response.json() as { applied: boolean }).applied).toBe(false);
      // The original rule is still enforced.
      expect((await check('database.delete', 'production')).json()).toMatchObject({
        effect: DECISION_EFFECT.WITHHOLD,
      });
    });

    it('rejects an unknown effect', async () => {
      const response = await put({
        version: 1,
        policies: [
          {
            name: 'bad-effect',
            match: { actions: ['*'] },
            decision: { effect: 'destroy' },
          },
        ],
      });

      expect(response.statusCode).toBe(400);
    });

    it('requires an admin credential', async () => {
      const response = await put(REPLACEMENT, 'not-the-admin-token');

      expect(response.statusCode).toBe(401);
    });

    it('rejects an unauthenticated caller', async () => {
      const response = await server.app.inject({
        method: 'PUT',
        url: '/v1/policies',
        payload: REPLACEMENT,
      });

      expect(response.statusCode).toBe(401);
    });
  });

  describe('without a policy file', () => {
    it('refuses rather than accepting a write it cannot persist', async () => {
      const fileless = await buildServer({ dataDir, adminToken: ADMIN });
      const response = await fileless.app.inject({
        method: 'PUT',
        url: '/v1/policies',
        headers: { authorization: `Bearer ${ADMIN}` },
        payload: REPLACEMENT,
      });

      expect(response.statusCode).toBe(409);
      await fileless.app.close();
    });
  });
});
