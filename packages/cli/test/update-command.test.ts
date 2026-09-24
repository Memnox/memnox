import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { describe, expect, it, vi } from 'vitest';
import { CliContext } from '../src/cli-context';
import { RecordedOutput } from '../src/cli-output';
import { plainStyle } from '../src/style';
import { registerUpdateCommand, type UpdateDeps } from '../src/commands/update.command';
import { INSTALL_METHOD, installOf, isNewer } from '../src/commands/update/install';
import { keepBoundary } from '../src/keeper/kept';
import type { Wiring } from '../src/setup-wiring';

/**
 * `memnox update` says what is installed and what is out, and upgrades only after a yes,
 * with the command for how this copy was installed. Nothing here reaches a network or
 * runs a package manager: the lookup, the installer and the rewiring are all injected.
 */

const NPM_ENTRY = '/usr/local/lib/node_modules/memnox/dist/index.js';

interface Harness {
  out: RecordedOutput;
  run: ReturnType<typeof vi.fn>;
  rewire: ReturnType<typeof vi.fn>;
}

async function update(
  overrides: Partial<UpdateDeps>,
  args: string[] = ['update'],
): Promise<Harness> {
  const home = await mkdtemp(join(tmpdir(), 'memnox-update-'));
  const out = new RecordedOutput();
  const program = new Command();
  const run = vi.fn(async () => true);
  const rewire = vi.fn(async () => true);
  registerUpdateCommand(program, new CliContext(out, plainStyle), {
    home: () => home,
    installed: () => '0.12.0',
    latest: async () => '0.13.0',
    install: () => installOf(NPM_ENTRY),
    confirm: async () => true,
    run,
    rewire,
    ...overrides,
  });
  await program.parseAsync(args, { from: 'user' });
  return { out, run, rewire };
}

describe('memnox update', () => {
  it('upgrades with the command for how it was installed, after a yes', async () => {
    const { out, run } = await update({});

    expect(out.text).toContain('0.12.0');
    expect(out.text).toContain('0.13.0');
    expect(run).toHaveBeenCalledWith(['npm', 'install', '-g', 'memnox@latest']);
    expect(out.text).toContain('now 0.13.0');
  });

  it('rewires a machine that was set up, through the new install', async () => {
    const home = await mkdtemp(join(tmpdir(), 'memnox-update-kept-'));
    await keepBoundary(home, ['Claude Code']);
    const { rewire } = await update({ home: () => home });

    expect(rewire).toHaveBeenCalledOnce();
  });

  it('changes nothing when the person says no', async () => {
    const { out, run, rewire } = await update({ confirm: async () => false });

    expect(run).not.toHaveBeenCalled();
    expect(rewire).not.toHaveBeenCalled();
    expect(out.text).toContain('Nothing was changed');
  });

  it('says so offline, with the command to run by hand', async () => {
    const { out, run } = await update({ latest: async () => null });

    expect(run).not.toHaveBeenCalled();
    expect(out.text).toContain('could not be looked up');
    expect(out.text).toContain('npm install -g memnox@latest');
  });

  it('asks nothing when this is already the latest', async () => {
    const confirm = vi.fn(async () => true);
    const { out, run } = await update({ latest: async () => '0.12.0', confirm });

    expect(confirm).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
    expect(out.text).toContain('latest version');
  });

  it('prints the command rather than guessing where the install is unrecognised', async () => {
    const { out, run } = await update({
      install: () => installOf('/Users/ada/src/memnox/dist/index.js'),
    });

    expect(run).not.toHaveBeenCalled();
    expect(out.text).toContain('npm install -g memnox@latest');
  });

  it('rewires in place when the new install is asked to, leaving the rules alone', async () => {
    const wire = vi.fn(async () => ({ interceptors: 7 }) as Wiring);
    const { out } = await update({ wire }, ['update', '--rewire']);

    expect(wire).toHaveBeenCalledOnce();
    expect(out.text).toContain('7 interceptors');
  });
});

describe('how this copy was installed', () => {
  it('reads the method off the resolved path', () => {
    expect(installOf(NPM_ENTRY).method).toBe(INSTALL_METHOD.NPM);
    expect(
      installOf('/Users/ada/Library/pnpm/global/5/node_modules/memnox/dist/index.js'),
    ).toMatchObject({
      method: INSTALL_METHOD.PNPM,
      command: ['pnpm', 'add', '-g', 'memnox@latest'],
    });
    expect(
      installOf('/Users/ada/.npm/_npx/1a2b/node_modules/memnox/dist/index.js'),
    ).toMatchObject({
      method: INSTALL_METHOD.NPX,
      command: null,
    });
    expect(installOf('').method).toBe(INSTALL_METHOD.UNKNOWN);
  });

  it('compares versions as numbers', () => {
    expect(isNewer('0.13.0', '0.12.0')).toBe(true);
    expect(isNewer('0.12.10', '0.12.9')).toBe(true);
    expect(isNewer('0.12.0', '0.12.0')).toBe(false);
    expect(isNewer('0.11.9', '0.12.0')).toBe(false);
  });
});
