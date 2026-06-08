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
      effect: block
      reason: No AI database deletion
`;

describe('memory search API', () => {
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

  describe('POST /v1/memory/search', () => {
    it('searches recorded decisions', async () => {
      await server.app.inject({
        method: 'POST',
        url: '/v1/memory/decisions',
        payload: {
          title: 'Keep PostgreSQL',
          statement: 'Transactional services stay on PostgreSQL for consistency',
          owner: 'backend',
          actions: ['database.migrate'],
        },
      });

      const response = await server.app.inject({
        method: 'POST',
        url: '/v1/memory/search',
        payload: { query: 'postgresql' },
      });
      expect(response.statusCode).toBe(200);
      expect((response.json() as unknown[]).length).toBeGreaterThan(0);
    });

    it('requires a query', async () => {
      const response = await server.app.inject({
        method: 'POST',
        url: '/v1/memory/search',
        payload: {},
      });
      expect(response.statusCode).toBe(400);
    });
  });
});
