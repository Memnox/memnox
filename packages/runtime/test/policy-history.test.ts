import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { LightMyRequestResponse } from 'fastify';
import { DECISION_EFFECT } from '@memnox/core';
import { buildServer, type MemnoxServer } from '../src/server';

const ADMIN = ['admin', 'token', 'value'].join('-');

const START = `
version: 1
policies:
  - name: block-shell
    match:
      actions: ["shell.execute"]
    decision:
      effect: block
      reason: no shell
`;

const document = (name: string, action: string): Record<string, unknown> => ({
  version: 1,
  policies: [
    {
      name,
      match: { actions: [action] },
      decision: { effect: DECISION_EFFECT.BLOCK, reason: 'x' },
    },
  ],
});

interface HistoryEntry {
  version: string;
  policyNames: string[];
  restoredFrom?: string;
  policies?: unknown;
}

describe('policy history and rollback', () => {
  let dataDir: string;
  let policyFile: string;
  let server: MemnoxServer;
  let agentToken: string;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'memnox-history-'));
    policyFile = join(dataDir, 'policies.yaml');
    await writeFile(policyFile, START, 'utf8');
    server = await buildServer({
      dataDir,
      policyFile,
      adminToken: ADMIN,
      enforcement: { default: 'enforce' },
      shellGuard: false,
    });
    const registration = await server.app.inject({
      method: 'POST',
      url: '/v1/agents',
      headers: { authorization: `Bearer ${ADMIN}` },
      payload: { name: 'a', kind: 'custom' },
    });
    agentToken = (registration.json() as { token: string }).token;
  });

  afterEach(async () => {
    await server.app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const publish = (body: Record<string, unknown>): Promise<LightMyRequestResponse> =>
    server.app.inject({
      method: 'PUT',
      url: '/v1/policies',
      headers: { authorization: `Bearer ${ADMIN}` },
      payload: body,
    });

  const history = async (): Promise<HistoryEntry[]> => {
    const response = await server.app.inject({
      method: 'GET',
      url: '/v1/policies/history',
      headers: { authorization: `Bearer ${ADMIN}` },
    });
    return response.json() as HistoryEntry[];
  };

  const rollback = (version: string): Promise<LightMyRequestResponse> =>
    server.app.inject({
      method: 'POST',
      url: `/v1/policies/rollback/${version}`,
      headers: { authorization: `Bearer ${ADMIN}` },
    });

  const decide = async (action: string): Promise<string> => {
    const response = await server.app.inject({
      method: 'POST',
      url: '/v1/actions/check',
      headers: { authorization: `Bearer ${agentToken}` },
      payload: { action },
    });
    return (response.json() as { effect: string }).effect;
  };

  it('starts empty and records each publish newest first', async () => {
    expect(await history()).toEqual([]);

    await publish(document('rule-a', 'a.act'));
    await publish(document('rule-b', 'b.act'));

    const entries = await history();
    expect(entries).toHaveLength(2);
    expect(entries[0]?.policyNames).toEqual(['rule-b']);
    expect(entries[1]?.policyNames).toEqual(['rule-a']);
  });

  // The index is metadata; the rules themselves stay on /v1/policies.
  it('does not ship rule bodies in the index', async () => {
    await publish(document('rule-a', 'a.act'));

    expect((await history())[0]?.policies).toBeUndefined();
  });

  it('restores an earlier rule set', async () => {
    await publish(document('rule-a', 'a.act'));
    const first = (await history())[0]?.version ?? '';
    await publish(document('rule-b', 'b.act'));

    expect(await decide('a.act')).toBe(DECISION_EFFECT.ALLOW);

    const response = await rollback(first);
    expect(response.statusCode).toBe(200);
    expect(await decide('a.act')).toBe(DECISION_EFFECT.BLOCK);
    expect(await decide('b.act')).toBe(DECISION_EFFECT.ALLOW);
  });

  // A rollback is a new publish, not a rewind — the trail must stay append-only.
  it('records the rollback as its own entry naming what it restored', async () => {
    await publish(document('rule-a', 'a.act'));
    const first = (await history())[0]?.version ?? '';
    await publish(document('rule-b', 'b.act'));
    await rollback(first);

    const entries = await history();
    expect(entries).toHaveLength(3);
    expect(entries[0]?.restoredFrom).toBe(first);
  });

  it('survives a restart, because history is on disk', async () => {
    await publish(document('rule-a', 'a.act'));
    await server.app.close();
    server = await buildServer({ dataDir, policyFile, adminToken: ADMIN });

    expect(await history()).toHaveLength(1);
  });

  describe('rejection', () => {
    it('404s an unknown version', async () => {
      expect((await rollback('deadbeef1234')).statusCode).toBe(404);
    });

    it('requires an admin to roll back', async () => {
      await publish(document('rule-a', 'a.act'));
      const version = (await history())[0]?.version ?? '';

      const response = await server.app.inject({
        method: 'POST',
        url: `/v1/policies/rollback/${version}`,
        headers: { authorization: 'Bearer not-the-admin' },
      });
      expect(response.statusCode).toBe(401);
    });

    it('records nothing when the document is invalid', async () => {
      await publish({ version: 1, policies: [{ name: 'broken' }] });

      expect(await history()).toEqual([]);
    });
  });
});
