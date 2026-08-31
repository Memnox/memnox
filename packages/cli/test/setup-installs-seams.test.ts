import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { describe, expect, it } from 'vitest';
import type { RuntimeConfig } from '@memnox/runtime';
import { CliContext } from '../src/cli-context';
import { RecordedOutput } from '../src/cli-output';
import { registerSetupCommand } from '../src/commands/setup.command';
import type { ServerLauncher } from '../src/commands/serve.command';
import { HookInstaller } from '../src/hook-installer';
import { McpInstaller } from '../src/mcp-installer';
import { plainStyle } from '../src/style';
import { FakeRuntime } from './cli-harness';

const HOOK_COMMAND = '/usr/bin/node /opt/memnox/tool-hook/cli.js';

const launchStub: ServerLauncher = async (overrides) => ({
  config: { host: '127.0.0.1', port: overrides.port ?? 7466 } as RuntimeConfig,
});

/** Absent reads as absent, so "never created" and "unchanged" are both provable. */
function snapshot(path: string): string | null {
  return existsSync(path) ? readFileSync(path, 'utf8') : null;
}

async function runSetup(
  home: string,
  installers?: { mcp: McpInstaller; hook: HookInstaller },
): Promise<RecordedOutput> {
  const out = new RecordedOutput();
  const runtime = new FakeRuntime();
  const program = new Command();
  program.exitOverride();
  if (installers === undefined) {
    // The defaults themselves are what one of these tests is about.
    registerSetupCommand(
      program,
      new CliContext(out, runtime.transport, plainStyle),
      launchStub,
      home,
      async () => false,
    );
  } else {
    registerSetupCommand(
      program,
      new CliContext(out, runtime.transport, plainStyle),
      launchStub,
      home,
      async () => false,
      installers.mcp,
      installers.hook,
    );
  }
  await program.parseAsync([
    'node',
    'memnox',
    'setup',
    '--no-serve',
    '--file',
    join(home, 'memnox.policies.yaml'),
  ]);
  return out;
}

describe('memnox setup installs the seams', () => {
  it('installs the tool hook, so the rules it just wrote are actually enforced', async () => {
    const home = mkdtempSync(join(tmpdir(), 'memnox-setup-seams-'));
    const hook = new HookInstaller(home, HOOK_COMMAND);

    const out = await runSetup(home, { mcp: new McpInstaller(home), hook });

    expect(out.text).toContain('Installed the Memnox tool hook');
    expect(await hook.installedCommand()).toBe(HOOK_COMMAND);
  });

  it('skips it when told to', async () => {
    const home = mkdtempSync(join(tmpdir(), 'memnox-setup-seams-'));
    const hook = new HookInstaller(home, HOOK_COMMAND);
    const out = new RecordedOutput();
    const program = new Command();
    program.exitOverride();

    registerSetupCommand(
      program,
      new CliContext(out, new FakeRuntime().transport, plainStyle),
      launchStub,
      home,
      async () => false,
      new McpInstaller(home),
      hook,
    );
    await program.parseAsync([
      'node',
      'memnox',
      'setup',
      '--no-serve',
      '--no-hooks',
      '--file',
      join(home, 'memnox.policies.yaml'),
    ]);

    expect(await hook.installedCommand()).toBeNull();
  });

  /**
   * A defaulted installer that reached for the real home once wrote a hook into the
   * developer's own settings during a test run. The defaults follow the injected home.
   */
  it('writes nothing outside the home it was handed', async () => {
    const home = mkdtempSync(join(tmpdir(), 'memnox-setup-seams-'));
    const real = [
      join(homedir(), '.claude', 'settings.json'),
      join(homedir(), '.claude.json'),
    ];
    const before = real.map(snapshot);

    // No installer is injected, so this exercises the defaults themselves. Whether
    // the hook binary resolves is beside the point; the real home is not ours to touch.
    await runSetup(home);

    expect(real.map(snapshot)).toEqual(before);
  });
});
