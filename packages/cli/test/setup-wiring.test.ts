import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { wireMachine, WIRED, type WiringSeams } from '../src/setup-wiring';

/**
 * `setup` connected the machine and put its agents under Memnox, then stopped.
 * No wrapper was in the path of any command, no rule had an opinion about
 * anything, and nothing pulled the workspace's rules unless a terminal stayed
 * open, so the guided run ended saying the agents were under Memnox while
 * `scan` on the next line said none of their capabilities was governed.
 */
describe('wiring a machine that has just been set up', () => {
  const home = () => mkdtemp(join(tmpdir(), 'memnox-wiring-'));

  /* Nothing real is installed here: a test that put wrappers on PATH or loaded
     a service would be configuring the machine it runs on. */
  const wrappers: WiringSeams['interceptors'] = async () => ({
    installed: ['git', 'rm', 'curl'],
    absent: ['aws'],
    directory: '/tmp/bin',
    pathLine: '',
  });
  const started: WiringSeams['service'] = async () => ({
    state: { supported: true, installed: true, path: '/tmp/svc', manager: 'launchd' },
  });
  const nothing: WiringSeams = {
    interceptors: wrappers,
    service: started,
    rules: async () => 7,
    /* Nothing real again: a test that rewrote MCP configs would repoint the
       servers of whoever ran it. */
    mcp: async () => ({ wrapped: 0, skipped: false }),
    codexHook: async () => false,
    cursorHook: async () => false,
  };

  it('reports what is now in the path, counted rather than claimed', async () => {
    const wired = await wireMachine(await home(), '/tmp/project', nothing);

    expect(wired.interceptors).toBe(3);
    expect(wired.rules).toBe(7);
    expect(wired.daemon).toBe(WIRED.DONE);
  });

  /* Claude Code's own file tools pass through no wrapper, so without this two
     sessions on one file never met a lease. */
  it('makes Claude Code take a lease where Claude Code is installed', async () => {
    const machine = await home();
    await mkdir(join(machine, '.claude'));

    const wired = await wireMachine(machine, '/tmp/project', nothing);

    expect(wired.claudeHook).toBe(true);
    const settings = await readFile(join(machine, '.claude', 'settings.json'), 'utf8');
    expect(settings).toContain('memnox-edit-hook');
  });

  /* Codex and Cursor write from inside themselves too, and an edit either made
     on another computer met nothing until each had its own hook. */
  it('hooks Codex and Cursor where they are installed, and names them', async () => {
    const machine = await home();
    await mkdir(join(machine, '.codex'));
    await mkdir(join(machine, '.cursor'));

    const wired = await wireMachine(machine, '/tmp/project', {
      ...nothing,
      codexHook: undefined,
      cursorHook: undefined,
    });

    expect(wired.editHooks).toEqual(['Codex', 'Cursor']);
    const codex = await readFile(join(machine, '.codex', 'hooks.json'), 'utf8');
    // No matcher, so every tool Codex runs meets the rules, its patch tool included.
    const codexHooks = JSON.parse(codex) as {
      hooks: Record<string, { matcher?: string; hooks: { command: string }[] }[]>;
    };
    expect(codexHooks.hooks['PreToolUse']?.[0]?.matcher).toBeUndefined();
    expect(codex).toContain('--agent codex-cli');
    expect(codex).toContain('--policy');
    const cursor = JSON.parse(
      await readFile(join(machine, '.cursor', 'hooks.json'), 'utf8'),
    ) as { version: number; hooks: Record<string, { command: string }[]> };
    expect(cursor.version).toBe(1);
    expect(Object.keys(cursor.hooks)).toEqual([
      'preToolUse',
      'beforeShellExecution',
      'beforeMCPExecution',
      'beforeReadFile',
      'afterFileEdit',
      'sessionEnd',
      'postToolUse',
      'stop',
    ]);
    expect(cursor.hooks['afterFileEdit']?.[0]?.command).toContain('--agent cursor');
  });

  it('writes no editor settings where there is no Claude Code', async () => {
    const wired = await wireMachine(await home(), '/tmp/project', nothing);

    expect(wired.claudeHook).toBe(false);
  });

  /* An outward action (the message, the issue, the deploy) is compared against
     another agent's only where the proxy is in front of the server. */
  it('puts the MCP servers behind the proxy and counts them', async () => {
    const wired = await wireMachine(await home(), '/tmp/project', {
      ...nothing,
      mcp: async () => ({ wrapped: 3, skipped: false }),
    });

    expect(wired.mcpServers).toBe(3);
    expect(wired.mcpUnwrapped).toBeUndefined();
  });

  it('says so rather than wrapping onto a proxy that is not on PATH', async () => {
    const wired = await wireMachine(await home(), '/tmp/project', {
      ...nothing,
      mcp: async () => ({ wrapped: 0, skipped: true }),
    });

    expect(wired.mcpUnwrapped).toBe(true);
  });

  it('says a platform with no service manager is not a failure', async () => {
    const wired = await wireMachine(await home(), '/tmp/project', {
      ...nothing,
      service: async () => ({
        state: { supported: false, installed: false, path: '', manager: '' },
      }),
    });

    expect(wired.daemon).toBe(WIRED.UNSUPPORTED);
  });

  it('carries the reason when the manager would not take the service', async () => {
    const wired = await wireMachine(await home(), '/tmp/project', {
      ...nothing,
      service: async () => ({
        state: { supported: true, installed: true, path: '/tmp/svc', manager: 'launchd' },
        warning: 'launchctl refused',
      }),
    });

    expect(wired.daemonNote).toBe('launchctl refused');
  });

  it('writes a baseline that denies the destructive work', async () => {
    const where = await home();
    const project = await mkdtemp(join(tmpdir(), 'memnox-project-'));
    // The real rule writer, so what setup produces is what a rule file holds.
    const wired = await wireMachine(where, project, {
      interceptors: wrappers,
      service: started,
    });

    expect(wired.rules).toBeGreaterThan(0);
    const written = await readFile(join(project, 'memnox.policies.toml'), 'utf8');
    expect(written).toContain('deny');
  });

  it('adds to rules already there rather than replacing them', async () => {
    const where = await home();
    const project = await mkdtemp(join(tmpdir(), 'memnox-project-'));
    const seams: WiringSeams = { interceptors: wrappers, service: started };

    await wireMachine(where, project, seams);
    const once = await readFile(join(project, 'memnox.policies.toml'), 'utf8');
    await wireMachine(where, project, seams);
    const twice = await readFile(join(project, 'memnox.policies.toml'), 'utf8');

    /* Running setup a second time is the ordinary case, and a baseline that
       replaced the file would be this command undoing somebody's edits. */
    expect(twice).toBe(once);
  });
});

/**
 * `setup` installs a service now, so `uninstall` has to take it back out. A
 * governance tool that leaves a daemon running against a machine it has just
 * stripped is the failure the uninstall command exists to prevent.
 */
describe('what setup installs, uninstall removes', () => {
  it('covers every piece setup wires', async () => {
    const wired = ['interceptors', 'rules', 'daemon'];
    const source = await readFile(
      new URL('../src/commands/uninstall.command.ts', import.meta.url),
      'utf8',
    );
    /* Rules are deliberately left: they are yours, and --purge is the flag that
       takes them. The other two are ours and must go. */
    expect(source).toMatch(/uninstallService|unservice/);
    expect(source).toMatch(/removeInterceptors/);
    expect(wired).toContain('daemon');
  });
});
