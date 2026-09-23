import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { describe, expect, it } from 'vitest';
import { planWrap, SESSION_BINARY } from '@memnox/core';
import {
  MANAGED_SERVER,
  managedServerFor,
  withManagedServer,
  withoutManagedServer,
} from '../src/agents/managed-server';
import { CliContext } from '../src/cli-context';
import { RecordedOutput } from '../src/cli-output';
import { registerUninstallCommand } from '../src/commands/uninstall.command';
import { describeMcp } from '../src/commands/setup/summary';
import { keepOnce, KEPT_CHANGE } from '../src/keeper/keep-boundary';
import { keepBoundary, markSession } from '../src/keeper/kept';
import {
  placeEverywhere,
  placeSessionServer,
  PLACED,
  removeEverywhere,
  SESSION_SERVER,
  SESSION_TARGETS,
  wireSessionTools,
  type SessionTarget,
} from '../src/session-tools/session-entry';
import { wireMachine, WIRED, type Wiring } from '../src/setup-wiring';
import { plainStyle } from '../src/style';

/**
 * The session server reaches each installed agent through its own MCP entry: put in by
 * setup, kept by the daemon unless taken out on purpose, and removed by uninstall.
 */

function target(name: string): SessionTarget {
  const found = SESSION_TARGETS.find((each) => each.name === name);
  if (found === undefined) throw new Error(`no target ${name}`);
  return found;
}

async function home(...installed: string[]): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'memnox-session-wiring-'));
  for (const each of installed)
    await mkdir(join(dir, target(each).installedDir), { recursive: true });
  return dir;
}

const CLAUDE_CONFIG = `{
    // kept by hand
    "theme": "dark",
    "mcpServers": {
        "github": {
            "command": "gh-mcp"
        }
    }
}
`;

describe('the session server in each agent config', () => {
  it('goes into an installed agent beside its servers, naming the agent, every other line kept', async () => {
    const dir = await home('Claude Code');
    const path = join(dir, '.claude.json');
    await writeFile(path, CLAUDE_CONFIG);

    expect(await placeSessionServer(dir, target('Claude Code'))).toBe(PLACED.WRITTEN);
    const after = await readFile(path, 'utf8');
    expect(after).toContain('// kept by hand');
    expect(after).toContain('    "theme": "dark",\n');
    expect(after).toContain('"command": "gh-mcp"');
    expect(after).toContain(`"${SESSION_SERVER}"`);
    expect(after).toContain('"claude-code"');
    expect(await placeSessionServer(dir, target('Claude Code'))).toBe(PLACED.PRESENT);
  });

  it('never invents an agent that is not installed', async () => {
    const dir = await home();
    expect(await placeSessionServer(dir, target('Cursor'))).toBe(PLACED.ABSENT);
    expect(existsSync(join(dir, '.cursor'))).toBe(false);
  });

  it('writes Codex TOML as a table, and takes only that table back out', async () => {
    const dir = await home('Codex');
    const path = join(dir, '.codex', 'config.toml');
    await writeFile(path, 'model = "o3"\n\n[mcp_servers.docs]\ncommand = "docs-mcp"\n');
    await placeSessionServer(dir, target('Codex'));
    const placed = await readFile(path, 'utf8');
    expect(placed).toContain(`[mcp_servers.${SESSION_SERVER}]`);
    expect(placed).toContain('args = ["--agent", "codex-cli"]');

    expect(await removeEverywhere(dir)).toEqual(['Codex']);
    expect(await readFile(path, 'utf8')).toBe(
      'model = "o3"\n\n[mcp_servers.docs]\ncommand = "docs-mcp"\n',
    );
  });

  it('never collides with the cloud entry onboarding writes, in either direction', async () => {
    expect(SESSION_SERVER).not.toBe(MANAGED_SERVER);
    const dir = await home('Claude Code');
    const path = join(dir, '.claude.json');
    const onboarded = withManagedServer(
      CLAUDE_CONFIG,
      'mcpServers',
      managedServerFor('https://cloud.test/mcp', 'tok'),
    );
    await writeFile(path, onboarded.next ?? '');
    await placeSessionServer(dir, target('Claude Code'));
    const both = await readFile(path, 'utf8');
    expect(both).toContain(`"${MANAGED_SERVER}"`);
    expect(both).toContain(`"${SESSION_SERVER}"`);

    const offboarded = withoutManagedServer(both, 'mcpServers').next ?? '';
    expect(offboarded).toContain(`"${SESSION_SERVER}"`);
    expect(offboarded).not.toContain('cloud.test');

    await removeEverywhere(dir);
    expect(await readFile(path, 'utf8')).toContain('cloud.test');
  });

  it('is left out where the binary is not on PATH, since an entry for nothing only fails', async () => {
    const dir = await home('Claude Code');
    expect((await wireSessionTools(dir, () => false)).held).toEqual([]);
    expect((await wireSessionTools(dir, () => true)).held).toEqual(['Claude Code']);
  });
});

describe('the proxy and the session server', () => {
  it('never wraps the session server, by bare name or full path', () => {
    const plan = planWrap({
      [SESSION_SERVER]: { command: SESSION_BINARY, args: ['--agent', 'claude-code'] },
      pinned: { command: `/usr/local/bin/${SESSION_BINARY}`, args: [] },
      github: { command: 'gh-mcp', args: [] },
    });
    expect(plan.wrap.map((each) => each.name)).toEqual(['github']);
    expect(plan.alreadyWrapped).toEqual([]);
  });
});

describe('setup, the keeper and uninstall', () => {
  it('setup puts the tools in and says which agents can ask', async () => {
    const dir = await home('Claude Code');
    const wired = await wireMachine(dir, dir, {
      interceptors: async () => ({
        installed: [],
        absent: [],
        directory: '',
        pathLine: '',
      }),
      rules: async () => 0,
      service: async () => ({
        state: { supported: false, installed: false, path: '', manager: 'none' },
      }),
      claudeHook: async () => false,
      codexHook: async () => false,
      cursorHook: async () => false,
      geminiHook: async () => false,
      windsurfHook: async () => false,
      mcp: async () => ({ wrapped: 0, skipped: false }),
      keep: async () => undefined,
      session: (at) => placeEverywhere(at),
    });
    expect(wired.sessionTools).toEqual(['Claude Code']);
    expect(describeMcp(wired)).toContain(
      'Claude Code can ask Memnox from inside a session',
    );
  });

  it('the keeper puts a missing entry back, and leaves it out once somebody said off', async () => {
    const dir = await home('Cursor');
    await keepBoundary(dir, []);
    const seams = {
      targets: [],
      wrap: async () => ({ names: [] }),
      projects: () => [],
      session: (at: string) => placeEverywhere(at),
    };
    const first = await keepOnce(dir, seams);
    expect(first).toContainEqual(
      expect.objectContaining({ kind: KEPT_CHANGE.SESSION, agents: ['Cursor'] }),
    );
    expect(await keepOnce(dir, seams)).toEqual([]);

    await removeEverywhere(dir);
    await markSession(dir, false);
    expect(await keepOnce(dir, seams)).toEqual([]);
    expect(await readFile(join(dir, '.cursor', 'mcp.json'), 'utf8')).not.toContain(
      SESSION_SERVER,
    );
  });

  it('uninstall takes the entry out of every agent', async () => {
    const dir = await home('Claude Code', 'Cursor');
    await placeEverywhere(dir);
    const repo = await mkdtemp(join(tmpdir(), 'memnox-session-repo-'));
    const out = new RecordedOutput();
    const program = new Command();
    registerUninstallCommand(program, new CliContext(out, plainStyle), {
      home: () => dir,
      dir: () => repo,
      unservice: async () => ({
        state: { supported: false, installed: false, path: '', manager: 'none' },
      }),
    });
    await program.parseAsync(['uninstall'], { from: 'user' });
    expect(out.text).toContain('Session tools');
    expect(await readFile(join(dir, '.claude.json'), 'utf8')).not.toContain(
      SESSION_SERVER,
    );
    expect(await readFile(join(dir, '.cursor', 'mcp.json'), 'utf8')).not.toContain(
      SESSION_SERVER,
    );
  });
});

it('keeps Wiring readable without the session field, as older callers build it', () => {
  const wired: Wiring = {
    interceptors: 0,
    absent: 0,
    rules: 0,
    daemon: WIRED.UNSUPPORTED,
    claudeHook: false,
    editHooks: [],
    mcpServers: 0,
  };
  expect(describeMcp(wired)).toBe('');
});
