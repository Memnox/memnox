import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildServer, type MemnoxServer } from '../src/server';

/** Writing one source must not silently drop the others. */
describe('writing one rule source', () => {
  let dataDir: string;
  let ownFile: string;
  let orgFile: string;
  let registry: string;
  let server: MemnoxServer;

  const rule = (name: string, action: string): string =>
    [
      `  - name: ${name}`,
      '    match:',
      `      actions: ["${action}"]`,
      '    decision:',
      '      effect: withhold',
      `      reason: ${name}`,
    ].join('\n');

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'memnox-compose-'));
    ownFile = join(dataDir, 'memnox.policies.yaml');
    orgFile = join(dataDir, 'org.yaml');
    registry = join(dataDir, 'policies.json');

    await writeFile(
      ownFile,
      `version: 1\npolicies:\n${rule('mine', 'file.write')}\n`,
      'utf8',
    );
    await writeFile(
      orgFile,
      `version: 1\npolicies:\n${rule('theirs', 'deploy.service')}\n`,
      'utf8',
    );
    await writeFile(registry, JSON.stringify({ files: [orgFile] }), 'utf8');

    server = await buildServer({
      dataDir,
      policyFile: ownFile,
      policyRegistryFile: registry,
    });
  });

  afterEach(async () => {
    await server.app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const names = async (): Promise<string[]> =>
    (
      (await server.app.inject({ method: 'GET', url: '/v1/policies' })).json() as {
        policyNames: string[];
      }
    ).policyNames;

  it('composes both sources at boot', async () => {
    expect((await names()).sort()).toEqual(['mine', 'theirs']);
  });

  it('keeps the other source in force after a write', async () => {
    const response = await server.app.inject({
      method: 'PUT',
      url: '/v1/policies',
      payload: {
        version: 1,
        policies: [
          {
            name: 'mine',
            match: { actions: ['file.write'] },
            decision: { effect: 'withhold' },
          },
          {
            name: 'added',
            match: { actions: ['file.read'] },
            decision: { effect: 'withhold' },
          },
        ],
      },
    });

    expect(response.statusCode).toBe(200);
    expect((await names()).sort()).toEqual(['added', 'mine', 'theirs']);
  });

  it('still enforces the other source on a real decision', async () => {
    const registered = await server.app.inject({
      method: 'POST',
      url: '/v1/agents',
      payload: { name: 'bot', kind: 'custom' },
    });
    const token = (registered.json() as { token: string }).token;

    await server.app.inject({
      method: 'PUT',
      url: '/v1/policies',
      payload: {
        version: 1,
        policies: [
          {
            name: 'mine',
            match: { actions: ['file.write'] },
            decision: { effect: 'withhold' },
          },
        ],
      },
    });

    const decision = await server.app.inject({
      method: 'POST',
      url: '/v1/actions/check',
      headers: { authorization: `Bearer ${token}` },
      payload: { action: 'deploy.service', target: 'api' },
    });
    expect(decision.json()).toMatchObject({ effect: 'withhold' });
  });

  it('names only its own file as editable', async () => {
    const view = (
      await server.app.inject({ method: 'GET', url: '/v1/policies' })
    ).json() as { writable: Array<{ name: string }> };

    expect(view.writable.map((policy) => policy.name)).toEqual(['mine']);
  });
});
