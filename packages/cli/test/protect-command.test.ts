import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { registerProtectCommand } from '../src/commands/protect.command';
import { EditorHookInstaller } from '../src/editor-hook-installer';
import { HOOK_MATCHER } from '../src/hook-mapping';
import { runCommand } from './cli-harness';

let home: string;

const hookCommandFor = (agent: string): string => `/usr/bin/node /cli.js hook ${agent}`;

const installerFor = (): EditorHookInstaller =>
  new EditorHookInstaller(home, hookCommandFor);

async function runProtect(args: string[]): ReturnType<typeof runCommand> {
  return runCommand(
    (program, context) => registerProtectCommand(program, context, installerFor()),
    ['protect', ...args],
  );
}

const readJson = async (path: string): Promise<Record<string, unknown>> =>
  JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'memnox-home-'));
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe('memnox protect claude-code', () => {
  it('writes a PreToolUse hook scoped to the intercepted tools', async () => {
    const { out } = await runProtect(['claude-code']);

    const settings = await readJson(join(home, '.claude', 'settings.json'));
    const groups = (settings['hooks'] as Record<string, unknown>)['PreToolUse'] as Array<{
      matcher: string;
      hooks: Array<{ command: string; timeout: number }>;
    }>;

    expect(groups[0]?.matcher).toBe(HOOK_MATCHER);
    expect(groups[0]?.hooks[0]?.command).toBe(hookCommandFor('claude-code'));
    expect(out.text).toContain('installed  claude-code');
  });

  it('is idempotent — a second run reports "already" and adds nothing', async () => {
    await runProtect(['claude-code']);
    const { out } = await runProtect(['claude-code']);

    const settings = await readJson(join(home, '.claude', 'settings.json'));
    const groups = (settings['hooks'] as Record<string, unknown>)['PreToolUse'] as [];

    expect(groups).toHaveLength(1);
    expect(out.text).toContain('already    claude-code');
  });

  it('leaves unrelated settings and pre-existing hooks untouched', async () => {
    const path = join(home, '.claude', 'settings.json');
    await mkdir(join(home, '.claude'), { recursive: true });
    await writeFile(
      path,
      JSON.stringify({
        model: 'opus',
        hooks: {
          PreToolUse: [{ matcher: 'Bash', hooks: [{ command: 'their-own-hook' }] }],
        },
      }),
      'utf8',
    );

    await runProtect(['claude-code']);

    const settings = await readJson(path);
    const groups = (settings['hooks'] as Record<string, unknown>)['PreToolUse'] as Array<{
      hooks: Array<{ command: string }>;
    }>;

    expect(settings['model']).toBe('opus');
    expect(groups).toHaveLength(2);
    expect(groups[0]?.hooks[0]?.command).toBe('their-own-hook');
  });
});

describe('memnox protect cursor', () => {
  it('registers the hook on every governed event', async () => {
    await runProtect(['cursor']);

    const config = await readJson(join(home, '.cursor', 'hooks.json'));
    const hooks = config['hooks'] as Record<string, Array<{ command: string }>>;

    expect(Object.keys(hooks).length).toBeGreaterThanOrEqual(4);
    for (const entries of Object.values(hooks)) {
      expect(entries[0]?.command).toBe(hookCommandFor('cursor'));
    }
    expect(config['version']).toBe(1);
  });

  it('is idempotent across runs', async () => {
    await runProtect(['cursor']);
    const { out } = await runProtect(['cursor']);

    const config = await readJson(join(home, '.cursor', 'hooks.json'));
    const hooks = config['hooks'] as Record<string, unknown[]>;

    for (const entries of Object.values(hooks)) expect(entries).toHaveLength(1);
    expect(out.text).toContain('already    cursor');
  });
});

describe('memnox protect (detection)', () => {
  it('says nothing was detected when the home directory is empty', async () => {
    const { out } = await runProtect([]);

    expect(out.text).toContain('No supported editors detected');
    expect(out.text).toContain('memnox protect <claude-code|cursor>');
  });

  it('installs only into the editors whose config directory exists', async () => {
    await mkdir(join(home, '.cursor'), { recursive: true });

    const { out } = await runProtect([]);

    expect(out.text).toContain('cursor');
    expect(out.text).not.toContain('claude-code');
  });

  it('installs into both when both are present', async () => {
    await mkdir(join(home, '.claude'), { recursive: true });
    await mkdir(join(home, '.cursor'), { recursive: true });

    const { out } = await runProtect([]);

    expect(out.text).toContain('claude-code');
    expect(out.text).toContain('cursor');
    expect(out.text).toContain('stays inactive until it has a token');
    expect(out.text).toContain('memnox setup');
  });

  it('rejects an agent it does not support', async () => {
    await expect(runProtect(['emacs'])).rejects.toThrow(/unsupported agent "emacs"/);
  });
});
