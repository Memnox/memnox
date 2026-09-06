import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { writeOrgConditions } from '@memnox/core';
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

const STATE_POLICY = `version: 1
policies:
  - name: no-deploys-while-frozen
    match:
      actions: ["shell.deploy"]
      state: ["freeze:deploys"]
    decision:
      effect: deny
      reason: "deploys are frozen for this workspace"
`;

/** A home directory as `memnox setup` would have left it. */
function home(
  options: {
    registry?: boolean;
    config?: Record<string, string>;
    /** Adds a rule that only bites while the workspace has frozen deploys. */
    statePolicy?: boolean;
  } = {},
): {
  dir: string;
  policyFile: string;
} {
  const dir = mkdtempSync(join(tmpdir(), 'memnox-hook-config-'));
  const policyFile = join(dir, 'memnox.policies.yaml');
  writeFileSync(policyFile, options.statePolicy === true ? STATE_POLICY : POLICY);
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
    const gate = await loadHookGate(await readHookConfig({}, dir), dir);
    expect(
      gate?.evaluate({ action: 'filesystem.read', target: '/srv/.env' }).effect,
    ).toBe('deny');
  });

  /* The gate read only the local freeze file, and `memnox sync` wrote what the
     workspace declared to a second one. So a production freeze was pulled by every
     machine, reported as applied, and consulted by none of them. */
  it('lets a condition the workspace declared reach the gate', async () => {
    const { dir } = home({ registry: true, statePolicy: true });
    await writeOrgConditions(dir, {
      syncedAt: Date.now(),
      conditions: [
        {
          id: 'c1',
          kind: 'freeze',
          subject: 'deploys',
          fromAt: 0,
          untilAt: Date.now() + 60 * 60 * 1000,
        },
      ],
    });

    const gate = await loadHookGate(await readHookConfig({}, dir), dir);

    expect(gate?.evaluate({ action: 'shell.deploy' }).effect).toBe('deny');
  });

  it('does not hold that condition once its window has passed', async () => {
    const { dir } = home({ registry: true, statePolicy: true });
    await writeOrgConditions(dir, {
      syncedAt: Date.now(),
      conditions: [
        { id: 'c1', kind: 'freeze', subject: 'deploys', fromAt: 0, untilAt: 1 },
      ],
    });

    const gate = await loadHookGate(await readHookConfig({}, dir), dir);

    expect(gate?.evaluate({ action: 'shell.deploy' }).effect).not.toBe('deny');
  });
});
