import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { LightMyRequestResponse } from 'fastify';
import { DECISION_EFFECT, type ActionEvent, type RiskAssessment } from '@memnox/core';
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

describe('decision API', () => {
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

  describe('POST /v1/decision', () => {
    it('returns the same verdict as the check endpoint', async () => {
      const response = await asAgent('/v1/decision', {
        action: 'database.delete',
        environment: 'production',
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ effect: DECISION_EFFECT.WITHHOLD });
    });

    it('rejects a request with no action', async () => {
      expect((await asAgent('/v1/decision', {})).statusCode).toBe(400);
    });
  });

  describe('POST /v1/authorize', () => {
    it('answers 200 when the action may proceed', async () => {
      const response = await asAgent('/v1/authorize', { action: 'code.read' });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ authorized: true });
    });

    it('answers 403 when it may not', async () => {
      const response = await asAgent('/v1/authorize', {
        action: 'database.delete',
        environment: 'production',
      });
      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({ authorized: false });
    });

    it('rejects an unauthenticated caller', async () => {
      const response = await server.app.inject({
        method: 'POST',
        url: '/v1/authorize',
        payload: { action: 'code.read' },
      });
      expect(response.statusCode).toBe(401);
    });
  });

  describe('POST /v1/evaluate-risk', () => {
    it('reports the verdict without recording anything', async () => {
      const before = (await auditEvents()).length;
      const response = await asAgent('/v1/evaluate-risk', {
        action: 'database.delete',
        environment: 'production',
      });

      const assessment = response.json() as RiskAssessment;
      expect(assessment.effect).toBe(DECISION_EFFECT.WITHHOLD);
      expect(assessment.trustScore).toBeGreaterThanOrEqual(0);
      // The whole point: asking must not look like attempting.
      expect((await auditEvents()).length).toBe(before);
    });

    it('creates no approval for an action that would need one', async () => {
      await asAgent('/v1/evaluate-risk', { action: 'database.delete' });
      const approvals = await server.app.inject({ method: 'GET', url: '/v1/approvals' });
      expect(approvals.json()).toEqual([]);
    });
  });
});
