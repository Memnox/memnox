import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadPolicyFiles, readPolicyRegistry } from '../src/policy-loader';
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

  it('tags every rule with the project its file declared', async () => {
    const file = join(dir, 'web.yaml');
    await writeFile(file, doc('acme', 'web-rule', 'allow'), 'utf8');

    const [policy] = await loadPolicyFiles([file]);

    expect(policy?.project).toBe('acme');
  });

  it('leaves rules unscoped when the file declares no project', async () => {
    const file = join(dir, 'base.yaml');
    await writeFile(file, doc(undefined, 'baseline', 'allow'), 'utf8');

    const [policy] = await loadPolicyFiles([file]);

    expect(policy?.project).toBeUndefined();
  });

  it('composes the rule files of every repository in a project', async () => {
    const web = join(dir, 'web.yaml');
    const api = join(dir, 'api.yaml');
    await writeFile(web, doc('acme', 'web-rule', 'allow'), 'utf8');
    await writeFile(api, doc('acme', 'api-rule', 'block'), 'utf8');

    const policies = await loadPolicyFiles([web, api]);

    expect(policies.map((policy) => policy.name)).toEqual(['web-rule', 'api-rule']);
  });

  it('treats a missing registry as no extra sources, not an error', async () => {
    expect(await readPolicyRegistry(join(dir, 'absent.json'))).toEqual([]);
  });

  it('reads the file list a joining repository registered', async () => {
    const registry = join(dir, 'policies.json');
    await writeFile(registry, JSON.stringify({ files: ['/a.yaml', '/b.yaml'] }), 'utf8');

    expect(await readPolicyRegistry(registry)).toEqual(['/a.yaml', '/b.yaml']);
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
    await writeFile(api, doc('acme', 'api-rule', 'block'), 'utf8');
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
});
