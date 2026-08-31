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
      effect: withhold
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

  it('finds the runtime and token setup stored, because a desktop agent has no shell', async () => {
    const { dir } = home({ config: { url: 'http://127.0.0.1:4000', token: 'mnx_1' } });
    const config = await readHookConfig({}, dir);
    expect(config.runtimeUrl).toBe('http://127.0.0.1:4000');
    expect(config.agentToken).toBe('mnx_1');
  });

  it('lets the environment win over what is on disk', async () => {
    const { dir } = home({
      registry: true,
      config: { url: 'http://stored', token: 'a' },
    });
    const config = await readHookConfig(
      { MEMNOX_POLICIES: '/tmp/one.yaml,/tmp/two.yaml', MEMNOX_URL: 'http://env' },
      dir,
    );
    expect(config.policyFiles).toEqual(['/tmp/one.yaml', '/tmp/two.yaml']);
    expect(config.runtimeUrl).toBe('http://env');
    expect(config.agentToken).toBe('a');
  });

  it('reads an unconfigured machine as empty rather than failing', async () => {
    const { dir } = home();
    const config = await readHookConfig({}, dir);
    expect(config).toEqual({ policyFiles: [], failOpen: false });
    expect(await loadHookGate(config)).toBeNull();
  });

  it('fails open only when told to, in as many words', async () => {
    const { dir } = home();
    expect((await readHookConfig({ MEMNOX_HOOK_FAIL_OPEN: 'true' }, dir)).failOpen).toBe(
      true,
    );
    expect((await readHookConfig({ MEMNOX_HOOK_FAIL_OPEN: '1' }, dir)).failOpen).toBe(
      false,
    );
  });

  it('builds a working gate from what setup left behind', async () => {
    const { dir } = home({ registry: true });
    const gate = await loadHookGate(await readHookConfig({}, dir));
    expect(
      gate?.evaluate({ action: 'filesystem.read', target: '/srv/.env' }).effect,
    ).toBe('withhold');
  });
});
