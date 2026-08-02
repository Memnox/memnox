import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ActionEvent } from '@memnox/core';
import { buildServer, type MemnoxServer } from '../src/server';

const POLICY_YAML = `version: 1
policies:
  - name: allow-reads
    match:
      actions: ["file.read"]
    decision:
      effect: allow
`;

describe('project scope over HTTP', () => {
  let dataDir: string;
  let server: MemnoxServer;
  let token: string;

  const check = async (projectId?: string): Promise<void> => {
    await server.app.inject({
      method: 'POST',
      url: '/v1/actions/check',
      headers: { authorization: `Bearer ${token}` },
      payload: { action: 'file.read', target: 'README.md', projectId },
    });
  };

  const audit = async (query = ''): Promise<ActionEvent[]> =>
    (await server.app.inject({ method: 'GET', url: `/v1/audit${query}` })).json();

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'memnox-project-'));
    const policyFile = join(dataDir, 'policies.yaml');
    await writeFile(policyFile, POLICY_YAML, 'utf8');
    server = await buildServer({ dataDir, policyFile });
    const registered = await server.app.inject({
      method: 'POST',
      url: '/v1/agents',
      payload: { name: 'local-editor', kind: 'claude-code' },
    });
    token = (registered.json() as { token: string }).token;
  });

  afterEach(async () => {
    await server.app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  it('records the project an action belongs to', async () => {
    await check('acme-checkout');

    expect((await audit())[0]?.projectId).toBe('acme-checkout');
  });

  it('filters the timeline to one project across every repository in it', async () => {
    await check('acme-checkout'); // e.g. the web repo
    await check('acme-checkout'); // e.g. the api repo
    await check('billing-service');

    expect(await audit('?project=acme-checkout')).toHaveLength(2);
    expect(await audit('?project=billing-service')).toHaveLength(1);
    expect(await audit()).toHaveLength(3);
  });

  it('leaves actions outside any project unstamped', async () => {
    await check();

    expect((await audit())[0]?.projectId).toBeUndefined();
    expect(await audit('?project=acme-checkout')).toHaveLength(0);
  });
});
