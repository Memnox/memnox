import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DECISION_EFFECT } from '@memnox/core';
import { buildServer, type MemnoxServer } from '../src/server';

const ADMIN = ['sim', 'admin', 'value'].join('-');

const LIVE = `
version: 1
policies:
  - name: allow-everything
    match:
      actions: ["never.matches"]
    decision:
      effect: withhold
`;

/** Blocks production deletes; staging is deliberately left alone. */
const CANDIDATE = {
  version: 1,
  policies: [
    {
      name: 'block-prod-delete',
      match: { actions: ['database.delete'], environments: ['production'] },
      decision: { effect: DECISION_EFFECT.WITHHOLD, reason: 'prod data' },
    },
  ],
};

interface Simulation {
  sampled: number;
  total: number;
  unchanged: number;
  changes: Array<{
    case: { action: string; environment?: string };
    before: string;
    after: string;
    stricter: boolean;
  }>;
  candidateTotals: Record<string, number>;
}

describe('policy simulation against real history', () => {
  let dataDir: string;
  let server: MemnoxServer;
  let agentToken: string;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'memnox-sim-'));
    const policyFile = join(dataDir, 'policies.yaml');
    await writeFile(policyFile, LIVE, 'utf8');
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
      payload: { name: 'sim-agent', kind: 'custom' },
    });
    agentToken = (registration.json() as { token: string }).token;
  });

  afterEach(async () => {
    await server.app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const act = (environment: string): Promise<unknown> =>
    server.app.inject({
      method: 'POST',
      url: '/v1/actions/check',
      headers: { authorization: `Bearer ${agentToken}` },
      payload: { action: 'database.delete', environment, sessionId: 's1' },
    });

  const simulate = (body: Record<string, unknown>) =>
    server.app.inject({
      method: 'POST',
      url: '/v1/policies/simulate',
      headers: { authorization: `Bearer ${ADMIN}` },
      payload: body,
    });

  it('reports only the actions whose verdict would change', async () => {
    await act('production');
    await act('staging');

    const response = await simulate(CANDIDATE);
    expect(response.statusCode).toBe(200);
    const body = response.json() as Simulation;

    expect(body.sampled).toBeGreaterThanOrEqual(2);
    const withheld = body.changes.filter(
      (change) => change.after === DECISION_EFFECT.WITHHOLD,
    );
    expect(withheld).toHaveLength(1);
    expect(withheld[0]?.case.environment).toBe('production');
    // Tightening is the usual reason to publish; the flag is what a UI sorts on.
    expect(withheld[0]?.stricter).toBe(true);
  });

  it('leaves the running rule set untouched', async () => {
    await act('production');
    await simulate(CANDIDATE);

    const live = await server.app.inject({
      method: 'GET',
      url: '/v1/policies',
      headers: { authorization: `Bearer ${ADMIN}` },
    });
    const names = (live.json() as { policies: Array<{ name: string }> }).policies.map(
      (policy) => policy.name,
    );
    expect(names).toEqual(['allow-everything']);
  });

  it('rejects a malformed candidate rather than simulating nonsense', async () => {
    const response = await simulate({ version: 1, policies: [{ name: 'broken' }] });

    expect(response.statusCode).toBe(400);
  });

  it('answers with an empty comparison when there is no history yet', async () => {
    const body = (await simulate(CANDIDATE)).json() as Simulation;

    expect(body.sampled).toBe(0);
    expect(body.changes).toEqual([]);
  });

  it('needs a credential', async () => {
    const response = await server.app.inject({
      method: 'POST',
      url: '/v1/policies/simulate',
      payload: CANDIDATE,
    });

    expect([401, 403]).toContain(response.statusCode);
  });
});
