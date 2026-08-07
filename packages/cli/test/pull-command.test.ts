import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Command } from 'commander';
import { parse } from 'yaml';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeAgentConfig } from '../src/agent-config';
import { CliContext } from '../src/cli-context';
import { RecordedOutput } from '../src/cli-output';
import type { CloudBundle, CloudClient } from '../src/cloud-client';
import { ENV_CLOUD_TOKEN, ENV_CLOUD_URL } from '../src/cloud-connection';
import { registerPullCommand } from '../src/commands/pull.command';
import { orgPolicyPath } from '../src/org-policy-source';
import { policyRegistryPath } from '../src/policy-registry';
import { plainStyle } from '../src/style';
import { FakeRuntime } from './cli-harness';

const CLOUD = { url: 'https://cloud.acme.test', token: 'mnc_dev', workspace: 'orbit' };
const ENV_VARS = [ENV_CLOUD_URL, ENV_CLOUD_TOKEN, 'MEMNOX_CLOUD_WORKSPACE'];

const RULE = {
  name: 'credential-file-protection',
  match: { actions: ['file.write'], targets: ['.env'] },
  decision: { effect: 'block', reason: 'Agents do not write credential files.' },
};

const BUNDLE: CloudBundle = {
  workspaceId: 'orbit',
  packs: ['auth-and-secrets'],
  issuedAt: '2026-08-07T00:00:00.000Z',
  version: 'abc123def456',
  policyCount: 1,
  policyNames: [RULE.name],
  policies: [RULE],
};

describe('memnox pull', () => {
  let home: string;
  let out: RecordedOutput;
  let saved: Record<string, string | undefined>;
  let asked: string[];
  let bundle: CloudBundle;

  const fakeClient = (): CloudClient =>
    ({
      me: async () => ({}),
      suggestions: async () => [],
      timeline: async () => [],
      bundle: async (workspace: string) => {
        asked.push(workspace);
        return bundle;
      },
    }) as unknown as CloudClient;

  // Injected so the command's reload can never leave the test and reach a real
  // runtime; an unstubbed route stands in for one that is not running.
  const run = async (args: string[], runtime = new FakeRuntime()): Promise<void> => {
    const program = new Command();
    program.exitOverride();
    registerPullCommand(
      program,
      new CliContext(out, runtime.transport, plainStyle, async () => ({}), {}),
      home,
      fakeClient,
    );
    await program.parseAsync(args, { from: 'user' });
  };

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'memnox-pull-'));
    out = new RecordedOutput();
    asked = [];
    bundle = BUNDLE;
    saved = {};
    for (const name of ENV_VARS) {
      saved[name] = process.env[name];
      delete process.env[name];
    }
    await writeAgentConfig(home, { cloud: CLOUD });
  });

  afterEach(async () => {
    for (const name of ENV_VARS) {
      const value = saved[name];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    process.exitCode = undefined;
    await rm(home, { recursive: true, force: true });
  });

  it('writes the org rules to their own file, not the repository one', async () => {
    await run(['pull', '--no-reload']);

    const written = parse(
      await readFile(orgPolicyPath(home, 'orbit'), 'utf8'),
    ) as unknown as { policies: { name: string }[] };
    expect(written.policies.map((policy) => policy.name)).toEqual([RULE.name]);
    expect(asked).toEqual(['orbit']);
  });

  it('registers the file so the runtime composes it with the repository rules', async () => {
    await run(['pull', '--no-reload']);

    const registry = JSON.parse(await readFile(policyRegistryPath(home), 'utf8')) as {
      files: string[];
    };
    expect(registry.files).toContain(orgPolicyPath(home, 'orbit'));
  });

  it('reports the version, so a developer can tell whether they are current', async () => {
    await run(['pull', '--no-reload']);

    expect(out.text).toContain('abc123def456');
    expect(out.text).toContain('auth-and-secrets');
    expect(out.text).toContain(RULE.name);
  });

  it('pulling twice registers one source, not two', async () => {
    await run(['pull', '--no-reload']);
    await run(['pull', '--no-reload']);

    const registry = JSON.parse(await readFile(policyRegistryPath(home), 'utf8')) as {
      files: string[];
    };
    expect(registry.files).toHaveLength(1);
  });

  it('asks the runtime to re-read them, and says which version is now in force', async () => {
    const runtime = new FakeRuntime().on('POST', '/v1/policies/reload', {
      reloaded: true,
      version: 'abc123def456',
    });

    await run(['pull'], runtime);

    expect(out.text).toContain('reloaded');
    expect(out.text).toContain('abc123def456');
  });

  it('says the rules are not in force when the runtime did not reload', async () => {
    // Writing a file the runtime never re-read would otherwise read as success.
    await run(['pull']);

    expect(out.text).toContain('did not reload');
    expect(out.text).toContain('not in force');
    expect(out.notes.join('\n')).toContain('memnox reload');
  });

  it('never writes outside the org directory, whatever the workspace id', async () => {
    await writeAgentConfig(home, { cloud: { ...CLOUD, workspace: '../../escape' } });
    bundle = { ...BUNDLE, workspaceId: '../../escape' };

    await run(['pull', '--no-reload']);

    // A workspace id reaches this from a URL; traversal must not escape the dir.
    const path = orgPolicyPath(home, '../../escape');
    expect(resolve(path)).toBe(
      join(resolve(home), '.memnox', 'org', '.._.._escape.yaml'),
    );
  });

  it('points someone who has not signed in at the command that fixes it', async () => {
    await writeAgentConfig(home, {});

    await run(['pull']);

    expect(out.text).toContain('memnox login');
    expect(asked).toEqual([]);
    expect(process.exitCode).toBe(1);
  });

  it('asks for a workspace rather than guessing one', async () => {
    await writeAgentConfig(home, { cloud: { url: CLOUD.url, token: CLOUD.token } });

    await run(['pull']);

    expect(out.text).toContain('--workspace');
    expect(asked).toEqual([]);
    expect(process.exitCode).toBe(1);
  });
});
