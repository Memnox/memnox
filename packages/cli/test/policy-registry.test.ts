import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { policyRegistryPath, registerPolicyFile } from '../src/policy-registry';

describe('policy registry', () => {
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'memnox-registry-'));
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it('creates the registry on the first repository to register', async () => {
    const files = await registerPolicyFile(home, 'memnox.policies.yaml');

    expect(files).toEqual([resolve('memnox.policies.yaml')]);
  });

  it('stores an absolute path so the runtime resolves it from its own directory', async () => {
    await registerPolicyFile(home, 'memnox.policies.yaml');

    const written: unknown = JSON.parse(await readFile(policyRegistryPath(home), 'utf8'));
    expect((written as { files: string[] }).files[0]).toBe(
      resolve('memnox.policies.yaml'),
    );
  });

  it('appends a second repository rather than replacing the first', async () => {
    await registerPolicyFile(home, '/repos/web/memnox.policies.yaml');
    const files = await registerPolicyFile(home, '/repos/api/memnox.policies.yaml');

    expect(files).toEqual([
      '/repos/web/memnox.policies.yaml',
      '/repos/api/memnox.policies.yaml',
    ]);
  });

  it('registers one file once however the caller spelled the path', async () => {
    await registerPolicyFile(home, '/repos/web/memnox.policies.yaml');
    const files = await registerPolicyFile(
      home,
      '/repos/web/../web/memnox.policies.yaml',
    );

    expect(files).toEqual(['/repos/web/memnox.policies.yaml']);
  });

  it('refuses to silently drop the rules a corrupt registry still names', async () => {
    const path = policyRegistryPath(home);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, '{ this is not json', 'utf8');

    // Returning [] here would re-register one repository over every other
    // repository's rules — the runtime would boot governing almost nothing.
    await expect(
      registerPolicyFile(home, '/repos/api/memnox.policies.yaml'),
    ).rejects.toThrow();
  });
});
