import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readHookConfig } from '../src/hook-config';
import { loadHookGate } from '../src/hook-gate-loader';

const POLICY = `version: 1
policies:
  - name: no-env
    match:
      actions: ["filesystem.read"]
      targets: ["*.env"]
    decision:
      effect: deny
      reason: "no credential need was declared"
`;

/** A home directory as `memnox setup` would have left it. */
function home(options: { registry?: boolean; config?: Record<string, string> } = {}): {
  dir: string;
  policyFile: string;
} {
  const dir = mkdtempSync(join(tmpdir(), 'memnox-hook-config-'));
  const policyFile = join(dir, 'memnox.policies.yaml');
  writeFileSync(policyFile, POLICY);
  mkdirSync(join(dir, '.memnox'), { recursive: true });

  if (options.registry === true) {
    writeFileSync(
      join(dir, '.memnox', 'policies.json'),
      JSON.stringify({ files: [policyFile] }),
    );
  }
  if (options.config !== undefined) {
    writeFileSync(join(dir, '.memnox', 'config.json'), JSON.stringify(options.config));
  }
  return { dir, policyFile };
}

describe('readHookConfig', () => {
  it('finds the policies setup registered, with no environment at all', async () => {
    const { dir, policyFile } = home({ registry: true });
    const config = await readHookConfig({}, dir);
    expect(config.policyFiles).toEqual([policyFile]);
  });

  it('lets the environment win over the registry on disk', async () => {
    const { dir } = home({ registry: true });
    const config = await readHookConfig(
      { MEMNOX_POLICIES: '/tmp/one.toml,/tmp/two.toml' },
      dir,
    );
    expect(config.policyFiles).toEqual(['/tmp/one.toml', '/tmp/two.toml']);
  });

  it('reads an unconfigured machine as empty rather than failing', async () => {
    const { dir } = home();
    const config = await readHookConfig({}, dir);
    expect(config).toEqual({ policyFiles: [] });
    expect(await loadHookGate(config)).toBeNull();
  });

  it('builds a working gate from the registered policy files', async () => {
    const { dir } = home({ registry: true });
    const gate = await loadHookGate(await readHookConfig({}, dir));
    expect(
      gate?.evaluate({ action: 'filesystem.read', target: '/srv/.env' }).effect,
    ).toBe('deny');
  });
});
