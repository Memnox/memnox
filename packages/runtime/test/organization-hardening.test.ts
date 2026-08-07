import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { LightMyRequestResponse } from 'fastify';
import type { Stated } from '@memnox/org-graph';
import { buildServer, type MemnoxServer } from '../src/server';
import { JsonFileStatedStore } from '../src/stores/json-file-stated-store';

const WORKSPACE = 'default';
const ADMIN_TOKEN = 'admin-everything';
const SCOPED_TOKEN = 'admin-acme-only';

const candidate = (over: Partial<Stated> = {}): Stated => ({
  id: 'candidate-1',
  workspaceId: WORKSPACE,
  kind: 'policy',
  statement: 'Deploys freeze in December.',
  subject: 'deploy.service',
  provenance: 'observed',
  status: 'candidate',
  version: 1,
  evidence: ['msg-1'],
  confidence: 0.9,
  detectedAt: '2026-05-01T00:00:00.000Z',
  ...over,
});

describe('organization hardening', () => {
  let dataDir: string;
  let server: MemnoxServer;
  let agentToken: string;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'memnox-hardening-'));
    server = await buildServer({
      dataDir,
      adminToken: ADMIN_TOKEN,
      // A management key confined to one workspace, beside an unscoped admin.
      apiKeys: [{ token: SCOPED_TOKEN, role: 'admin', workspace: 'acme' }],
      askRateLimitPerMinute: 3,
    });
    const registration = await server.app.inject({
      method: 'POST',
      url: '/v1/agents',
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      payload: { name: 'deploy-bot', kind: 'custom' },
    });
    agentToken = (registration.json() as { token: string }).token;
  });

  afterEach(async () => {
    await server.app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const asAdmin = (
    method: 'POST' | 'GET' | 'DELETE',
    url: string,
    payload?: Record<string, unknown>,
    token = ADMIN_TOKEN,
  ): Promise<LightMyRequestResponse> =>
    server.app.inject({
      method,
      url,
      headers: { authorization: `Bearer ${token}` },
      ...(payload === undefined ? {} : { payload }),
    });

  const evaluate = (): Promise<LightMyRequestResponse> =>
    server.app.inject({
      method: 'POST',
      url: `/v1/workspaces/${WORKSPACE}/evaluate`,
      headers: { authorization: `Bearer ${agentToken}` },
      payload: { action: 'deploy.service' },
    });

  describe('candidates are deduplicated', () => {
    it('files the same claim once, however many times it is read', async () => {
      const first = await asAdmin('POST', '/v1/organization/candidates', {
        candidates: [candidate()],
      });
      const second = await asAdmin('POST', '/v1/organization/candidates', {
        candidates: [candidate({ id: 'candidate-2' })],
      });

      expect(first.json()).toEqual({ stored: 1, duplicates: 0 });
      expect(second.json()).toEqual({ stored: 0, duplicates: 1 });
      expect((await asAdmin('GET', '/v1/organization/statements')).json()).toHaveLength(
        1,
      );
    });

    it('does not ask a person to reject the same claim twice', async () => {
      await asAdmin('POST', '/v1/organization/candidates', {
        candidates: [candidate()],
      });
      await asAdmin('POST', '/v1/organization/statements/candidate-1/reject', {
        by: 'alice',
      });

      const again = await asAdmin('POST', '/v1/organization/candidates', {
        candidates: [candidate({ id: 'candidate-3' })],
      });

      expect(again.json()).toEqual({ stored: 0, duplicates: 1 });
    });

    it('treats a claim differing only in whitespace or case as the same one', async () => {
      await asAdmin('POST', '/v1/organization/candidates', {
        candidates: [candidate()],
      });

      const reworded = await asAdmin('POST', '/v1/organization/candidates', {
        candidates: [
          candidate({ id: 'candidate-4', statement: '  DEPLOYS   freeze in December. ' }),
        ],
      });

      expect(reworded.json()).toEqual({ stored: 0, duplicates: 1 });
    });

    it('files a genuinely different claim about the same subject', async () => {
      await asAdmin('POST', '/v1/organization/candidates', {
        candidates: [candidate()],
      });

      const different = await asAdmin('POST', '/v1/organization/candidates', {
        candidates: [
          candidate({ id: 'candidate-5', statement: 'Deploys need two reviewers.' }),
        ],
      });

      expect(different.json()).toEqual({ stored: 1, duplicates: 0 });
    });

    it('files a batch in one write rather than one write per candidate', async () => {
      const filed = await asAdmin('POST', '/v1/organization/candidates', {
        candidates: [
          candidate({ id: 'a', statement: 'One.' }),
          candidate({ id: 'b', statement: 'Two.' }),
          candidate({ id: 'c', statement: 'Two.' }),
        ],
      });

      expect(filed.json()).toEqual({ stored: 2, duplicates: 1 });
    });
  });

  describe('superseding lands as one change', () => {
    it('never leaves a retired rule with no replacement on disk', async () => {
      const first = await asAdmin('POST', '/v1/organization/statements', {
        kind: 'policy',
        statement: 'Deploys need one reviewer.',
        subject: 'deploy.service',
      });
      const firstId = (first.json() as { id: string }).id;

      await asAdmin('POST', '/v1/organization/statements', {
        kind: 'policy',
        statement: 'Deploys need two reviewers.',
        subject: 'deploy.service',
        supersedes: firstId,
      });

      // Read the file back through a fresh store: whatever a restart would see.
      const reloaded = await new JsonFileStatedStore(
        join(dataDir, 'organization.json'),
      ).list(WORKSPACE);
      const retired = reloaded.find((stated) => stated.id === firstId);
      const successor = reloaded.find((stated) => stated.supersedesId === firstId);

      expect(retired?.status).toBe('superseded');
      expect(successor?.statement).toBe('Deploys need two reviewers.');
      expect(successor?.version).toBe(2);
    });

    it('leaves no scratch file behind', async () => {
      await asAdmin('POST', '/v1/organization/statements', {
        kind: 'policy',
        statement: 'Anything.',
        subject: 'deploy.service',
      });

      const written = await readFile(join(dataDir, 'organization.json'), 'utf8');
      expect(JSON.parse(written)).toHaveLength(1);
    });
  });

  describe('a management key is confined to its workspace', () => {
    it('refuses a scoped key reaching another workspace', async () => {
      const response = await asAdmin(
        'POST',
        '/v1/organization/statements',
        { kind: 'policy', statement: 'Not yours.', subject: 'deploy.service' },
        SCOPED_TOKEN,
      );

      expect(response.statusCode).toBe(403);
    });

    it('admits a scoped key to the workspace it names', async () => {
      const response = await asAdmin(
        'POST',
        '/v1/organization/statements?workspace=acme',
        { kind: 'policy', statement: 'Ours.', subject: 'deploy.service' },
        SCOPED_TOKEN,
      );

      expect(response.statusCode).toBe(201);
    });

    it('lets an unscoped admin key reach every workspace', async () => {
      const response = await asAdmin(
        'POST',
        '/v1/organization/statements?workspace=acme',
        { kind: 'policy', statement: 'Ours.', subject: 'deploy.service' },
      );

      expect(response.statusCode).toBe(201);
    });

    it('will not let a scoped key revoke another workspace’s delegation', async () => {
      const granted = await asAdmin('POST', '/v1/organization/authority', {
        principal: 'alice',
        actions: ['expense.approve'],
      });
      const grantId = (granted.json() as { id: string }).id;

      const revoked = await asAdmin(
        'DELETE',
        `/v1/organization/authority/${grantId}?workspace=acme`,
        undefined,
        SCOPED_TOKEN,
      );

      expect(revoked.statusCode).toBe(404);
      expect((await asAdmin('GET', '/v1/organization/authority')).json()).toHaveLength(1);
    });
  });

  describe('the organization protocol is throttled', () => {
    it('refuses an agent past its per-minute budget', async () => {
      const codes: number[] = [];
      for (let attempt = 0; attempt < 5; attempt += 1) {
        codes.push((await evaluate()).statusCode);
      }

      expect(codes.slice(0, 3)).toEqual([200, 200, 200]);
      expect(codes.slice(3)).toEqual([429, 429]);
    });

    it('counts per agent, so one agent cannot starve another', async () => {
      const other = await server.app.inject({
        method: 'POST',
        url: '/v1/agents',
        headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
        payload: { name: 'other-bot', kind: 'custom' },
      });
      const otherToken = (other.json() as { token: string }).token;

      for (let attempt = 0; attempt < 4; attempt += 1) await evaluate();

      const untouched = await server.app.inject({
        method: 'POST',
        url: `/v1/workspaces/${WORKSPACE}/evaluate`,
        headers: { authorization: `Bearer ${otherToken}` },
        payload: { action: 'deploy.service' },
      });

      expect(untouched.statusCode).toBe(200);
    });

    it('throttles an unknown credential too, so guessing is not free', async () => {
      const guess = (): Promise<LightMyRequestResponse> =>
        server.app.inject({
          method: 'POST',
          url: `/v1/workspaces/${WORKSPACE}/evaluate`,
          headers: { authorization: 'Bearer not-a-token' },
          payload: { action: 'deploy.service' },
        });

      const codes: number[] = [];
      for (let attempt = 0; attempt < 5; attempt += 1) {
        codes.push((await guess()).statusCode);
      }

      expect(codes.slice(0, 3)).toEqual([401, 401, 401]);
      expect(codes.slice(3)).toEqual([429, 429]);
    });

    it('does not let a stranger spend a real agent’s budget', async () => {
      for (let attempt = 0; attempt < 5; attempt += 1) {
        await server.app.inject({
          method: 'POST',
          url: `/v1/workspaces/${WORKSPACE}/evaluate`,
          headers: { authorization: 'Bearer not-a-token' },
          payload: { action: 'deploy.service' },
        });
      }

      expect((await evaluate()).statusCode).toBe(200);
    });
  });
});
