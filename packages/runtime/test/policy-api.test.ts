import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { LightMyRequestResponse } from 'fastify';
import { DECISION_EFFECT, type ActionEvent } from '@memnox/core';
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

describe('policy API', () => {
  let dataDir: string;
  let policyFile: string;
  let server: MemnoxServer;
  let token: string;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'memnox-platform-'));
    policyFile = join(dataDir, 'policies.yaml');
    await writeFile(policyFile, POLICY_YAML, 'utf8');
    server = await buildServer({ dataDir, policyFile });
    const registration = await server.app.inject({
      method: 'POST',
      url: '/v1/agents',
      payload: { name: 'claude-code', kind: 'claude-code' },
    });
    token = (registration.json() as { token: string }).token;
  });

  afterEach(async () => {
    await server.app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const asAgent = (
    url: string,
    payload: Record<string, unknown>,
  ): Promise<LightMyRequestResponse> =>
    server.app.inject({
      method: 'POST',
      url,
      headers: { authorization: `Bearer ${token}` },
      payload,
    });

  const auditEvents = async (): Promise<ActionEvent[]> => {
    const response = await server.app.inject({ method: 'GET', url: '/v1/audit' });
    return response.json() as ActionEvent[];
  };

  describe('policy endpoints', () => {
    it('lists the rule set with its content version', async () => {
      const response = await server.app.inject({ method: 'GET', url: '/v1/policies' });
      expect(response.json()).toMatchObject({
        policyCount: 1,
        policyNames: ['production-database-protection'],
      });
    });

    it('validates a candidate document', async () => {
      const valid = await server.app.inject({
        method: 'POST',
        url: '/v1/policies/validate',
        payload: {
          version: 1,
          policies: [
            { name: 'p', match: { actions: ['a'] }, decision: { effect: 'withhold' } },
          ],
        },
      });
      expect(valid.json()).toMatchObject({ valid: true, policyCount: 1 });

      const invalid = await server.app.inject({
        method: 'POST',
        url: '/v1/policies/validate',
        payload: { version: 1, policies: [{ name: 'broken' }] },
      });
      expect(invalid.statusCode).toBe(400);
      expect(invalid.json()).toMatchObject({ valid: false });
    });

    it('reloads the rule set from disk', async () => {
      await writeFile(
        policyFile,
        POLICY_YAML.replace('production-database-protection', 'renamed-policy'),
        'utf8',
      );
      const response = await server.app.inject({
        method: 'POST',
        url: '/v1/policies/reload',
      });

      expect(response.json()).toMatchObject({
        reloaded: true,
        policyNames: ['renamed-policy'],
      });
      const listed = await server.app.inject({ method: 'GET', url: '/v1/policies' });
      expect(listed.json()).toMatchObject({ policyNames: ['renamed-policy'] });
    });

    it('reports a reload failure without swapping in a broken rule set', async () => {
      await writeFile(policyFile, 'version: 1\npolicies: [{ name: broken }]\n', 'utf8');
      const response = await server.app.inject({
        method: 'POST',
        url: '/v1/policies/reload',
      });

      expect(response.statusCode).toBe(400);
      const listed = await server.app.inject({ method: 'GET', url: '/v1/policies' });
      expect(listed.json()).toMatchObject({
        policyNames: ['production-database-protection'],
      });
    });
  });
});
