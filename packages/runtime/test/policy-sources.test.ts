import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildServer, type MemnoxServer } from '../src/server';

const doc = (project: string | undefined, name: string, effect: string): string =>
  `${project === undefined ? '' : `project: ${project}\n`}version: 1
policies:
  - name: ${name}
    match: { actions: ["file.write"] }
    decision: { effect: ${effect}, reason: ${name} }
`;

describe('policy sources', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'memnox-sources-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('reloads a runtime onto a source registered after it started', async () => {
    const web = join(dir, 'web.yaml');
    const api = join(dir, 'api.yaml');
    const registry = join(dir, 'policies.json');
    await writeFile(web, doc('acme', 'web-rule', 'allow'), 'utf8');
    await writeFile(registry, JSON.stringify({ files: [web] }), 'utf8');

    const server: MemnoxServer = await buildServer({
      dataDir: dir,
      policyRegistryFile: registry,
    });
    expect(server.app).toBeDefined();

    // The second repository lands its rules and asks for a reload.
    await writeFile(api, doc('acme', 'api-rule', 'withhold'), 'utf8');
    await writeFile(registry, JSON.stringify({ files: [web, api] }), 'utf8');
    const response = await server.app.inject({
      method: 'POST',
      url: '/v1/policies/reload',
      payload: {},
    });

    expect(response.statusCode).toBe(200);
    const listed = await server.app.inject({ method: 'GET', url: '/v1/policies' });
    const names = (listed.json() as { policies: { name: string }[] }).policies.map(
      (policy) => policy.name,
    );
    expect(names).toEqual(['web-rule', 'api-rule']);
    await server.app.close();
  });

  it('loads one file once even when it is configured and registered differently', async () => {
    const file = join(dir, 'web.yaml');
    const registry = join(dir, 'policies.json');
    await writeFile(file, doc('acme', 'web-rule', 'withhold'), 'utf8');
    // `setup` passes the file relatively and registers it absolutely.
    await writeFile(registry, JSON.stringify({ files: [file] }), 'utf8');

    const server: MemnoxServer = await buildServer({
      dataDir: dir,
      policyFile: relative(process.cwd(), file),
      policyRegistryFile: registry,
    });

    const listed = await server.app.inject({ method: 'GET', url: '/v1/policies' });
    const names = (listed.json() as { policies: { name: string }[] }).policies.map(
      (policy) => policy.name,
    );

    expect(names).toEqual(['web-rule']);
    await server.app.close();
  });
});
