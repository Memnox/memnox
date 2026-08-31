import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildServer } from '../src/server';

const YAML = `version: 1
policies:
  - name: orbit-rule
    match: { actions: ["file.write"] }
    decision: { effect: withhold, reason: orbit }
`;

describe('the reported first-run failure', () => {
  it('starts even when another repo in the registry lost its policy file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'memnox-repro-'));
    const orbit = join(dir, 'memnox.policies.yaml');
    await writeFile(orbit, YAML, 'utf8');

    // Exactly the user's ~/.memnox/policies.json: one live path, one dead one.
    const registry = join(dir, 'policies.json');
    await writeFile(
      registry,
      JSON.stringify({
        files: [orbit, join(dir, 'deleted-repo', 'memnox.policies.yaml')],
      }),
      'utf8',
    );

    const server = await buildServer({
      dataDir: join(dir, 'data'),
      policyFile: orbit,
      policyRegistryFile: registry,
    });
    const response = await server.app.inject({ method: 'GET', url: '/v1/policies' });
    expect(response.statusCode).toBe(200);
    expect((response.json() as { policies: unknown[] }).policies).toHaveLength(1);
    await server.app.close();
    await rm(dir, { recursive: true, force: true });
  });
});
