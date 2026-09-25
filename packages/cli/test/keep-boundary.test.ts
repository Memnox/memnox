import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { installClaudeHook, runClaudeHook } from '../src/protect/claude-hook';
import {
  BoundaryKeeper,
  describeKept,
  keepOnce,
  KEPT_CHANGE,
  type KeepSeams,
} from '../src/keeper/keep-boundary';
import { forgetKept, keepBoundary, markMcp, readKept } from '../src/keeper/kept';
import type { EditHookTarget } from '../src/protect/agent-hooks';
import { withDefaultCommand } from '../src/program';
import { CliContext } from '../src/cli-context';
import { RecordedOutput } from '../src/cli-output';
import { plainStyle } from '../src/style';

/**
 * Setup wired the machine once, and then the machine kept changing: Cursor installed a
 * week later was never hooked, an editor that rewrote its settings dropped the hook, and a
 * Slack server added to a config ran straight past the proxy. Nothing said so, because
 * nothing was looking, and the only fix was knowing to run setup again.
 */
describe('the daemon keeping the boundary setup drew', () => {
  const home = () => mkdtemp(join(tmpdir(), 'memnox-keeper-'));
  const claude = (machine: string) => join(machine, '.claude', 'settings.json');

  /* Only Claude Code, and no MCP config: a test that rewrote real configs would
     repoint the agents of whoever ran it. */
  const onlyClaude: KeepSeams = {
    // Nothing on PATH decides this: whether memnox-session is installed is the machine's business.
    session: async () => ({ held: [], written: [], files: [] }),
    targets: [
      {
        name: 'Claude Code',
        file: join('.claude', 'settings.json'),
        agent: 'claude-code',
        install: installClaudeHook,
        remove: async () => false,
      } satisfies EditHookTarget,
    ],
    wrap: async () => ({ names: [] }),
    projects: () => [],
  };

  it('does nothing on a machine nobody set up', async () => {
    const machine = await home();
    await mkdir(join(machine, '.claude'));

    expect(await keepOnce(machine, onlyClaude)).toEqual([]);
    await expect(readFile(claude(machine), 'utf8')).rejects.toThrow();
  });

  it('hooks an agent installed after setup, and says it adopted it', async () => {
    const machine = await home();
    await keepBoundary(machine, []);
    await mkdir(join(machine, '.claude'));

    const changes = await keepOnce(machine, onlyClaude);

    expect(changes).toEqual([
      { kind: KEPT_CHANGE.ADOPTED, agent: 'Claude Code', probation: true },
    ]);
    expect(await readFile(claude(machine), 'utf8')).toContain('memnox-edit-hook');
    expect((await readKept(machine))?.hooked).toEqual(['Claude Code']);
  });

  it('puts back a hook somebody else took out, and says it was restored', async () => {
    const machine = await home();
    await mkdir(join(machine, '.claude'));
    await installClaudeHook(machine);
    await keepBoundary(machine, ['Claude Code']);
    await writeFile(claude(machine), '{"theme":"dark"}\n');

    const changes = await keepOnce(machine, onlyClaude);

    expect(changes).toEqual([{ kind: KEPT_CHANGE.RESTORED, agent: 'Claude Code' }]);
    const settings = await readFile(claude(machine), 'utf8');
    expect(settings).toContain('memnox-edit-hook');
    expect(settings).toContain('dark');
  });

  /* Rewriting to reorder would fight whoever owns the file on every pass. */
  it('leaves a file that already runs the hook exactly as it is', async () => {
    const machine = await home();
    await mkdir(join(machine, '.claude'));
    await installClaudeHook(machine);
    await keepBoundary(machine, ['Claude Code']);
    const before = await readFile(claude(machine), 'utf8');

    expect(await keepOnce(machine, onlyClaude)).toEqual([]);
    expect(await readFile(claude(machine), 'utf8')).toBe(before);
  });

  /* A hook written before Claude Code's named its agent ruled on every call as
     the default name, so the keeper rewrites it to say which agent it is. */
  it('upgrades a hook from before it named its agent', async () => {
    const machine = await home();
    await mkdir(join(machine, '.claude'));
    const unnamed = { type: 'command', command: 'memnox-edit-hook --tool-policy' };
    await writeFile(
      claude(machine),
      JSON.stringify({ hooks: { PreToolUse: [{ matcher: '*', hooks: [unnamed] }] } }),
    );
    await keepBoundary(machine, ['Claude Code']);

    const changes = await keepOnce(machine, onlyClaude);

    expect(changes).toEqual([{ kind: KEPT_CHANGE.UPGRADED, agent: 'Claude Code' }]);
    expect(await readFile(claude(machine), 'utf8')).toContain('--agent claude-code');
  });

  it('never puts back a hook somebody took out on purpose', async () => {
    const machine = await home();
    await mkdir(join(machine, '.claude'));
    await installClaudeHook(machine);
    await keepBoundary(machine, ['Claude Code']);
    await runClaudeHook(
      new CliContext(new RecordedOutput(), plainStyle),
      true,
      () => machine,
    );

    expect(await keepOnce(machine, onlyClaude)).toEqual([]);
    expect(await readFile(claude(machine), 'utf8')).not.toContain('memnox-edit-hook');
  });

  it('puts new MCP servers through the proxy, until somebody unwraps on purpose', async () => {
    const machine = await home();
    await keepBoundary(machine, []);
    const wrapping: KeepSeams = {
      ...onlyClaude,
      wrap: async () => ({ names: ['slack'] }),
    };

    expect(await keepOnce(machine, wrapping)).toEqual([
      { kind: KEPT_CHANGE.WRAPPED, servers: ['slack'], probation: ['slack'] },
    ]);

    await markMcp(machine, false);
    expect(await keepOnce(machine, wrapping)).toEqual([]);
  });

  it('stops keeping anything once uninstall forgets the boundary', async () => {
    const machine = await home();
    await keepBoundary(machine, []);
    await forgetKept(machine);
    await mkdir(join(machine, '.claude'));

    expect(await keepOnce(machine, onlyClaude)).toEqual([]);
  });

  it('tells the person each change, in the log and on the desktop', async () => {
    const machine = await home();
    await keepBoundary(machine, []);
    await mkdir(join(machine, '.claude'));
    const logged: string[] = [];
    const noticed: string[] = [];
    const keeper = new BoundaryKeeper(machine, {
      log: (message) => logged.push(message),
      notify: (message) => noticed.push(message),
      seams: onlyClaude,
      intervalMs: 60_000,
    });

    keeper.start();
    await expect.poll(() => noticed.length).toBe(1);
    keeper.stop();

    expect(noticed[0]).toBe(
      describeKept({ kind: KEPT_CHANGE.ADOPTED, agent: 'Claude Code', probation: true }),
    );
    expect(logged).toEqual(noticed);
  });
});

describe('what bare memnox runs', () => {
  const node = ['/usr/bin/node', '/usr/local/bin/memnox'];

  it('is the scan on a machine nobody set up', () => {
    expect(withDefaultCommand(node, false)).toEqual(node);
  });

  it('is the status view once setup has run', () => {
    expect(withDefaultCommand(node, true)).toEqual([...node, 'status']);
  });

  it('never replaces a command somebody typed', () => {
    expect(withDefaultCommand([...node, 'scan'], true)).toEqual([...node, 'scan']);
  });
});
