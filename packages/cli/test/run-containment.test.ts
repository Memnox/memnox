import { existsSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { describe, expect, it, vi } from 'vitest';
import {
  PROBATION_KIND,
  ProbationRegister,
  SessionContainments,
  type SessionContainment,
} from '@memnox/core';
import {
  EgressSeam,
  type EgressProxy,
  type EgressProxyOptions,
} from '@memnox/interceptors';
import { CliContext } from '../src/cli-context';
import { RecordedOutput } from '../src/cli-output';
import { plainStyle } from '../src/style';
import { registerRunCommand } from '../src/commands/run.command';
import {
  isFamiliar,
  normalizedOrigin,
  untrustedHint,
} from '../src/commands/run/familiar';
import { proxyEnvironment } from '../src/commands/run/network';
import { untrustedPreset } from '../src/commands/run/untrusted';
import { DaemonEgress, daemonEgressPort } from '../src/daemon/egress';
import { egressStatePath } from '../src/memnox-paths';
import { describeKept, KEPT_CHANGE } from '../src/keeper/keep-boundary';
import { startProbations } from '../src/keeper/keep-probation';
import { registerAgentsCommand } from '../src/commands/agents.command';
import { registerMcpCommand } from '../src/commands/mcp.command';
import { registerStatusCommand } from '../src/commands/status.command';

const NOW = new Date('2026-09-24T10:00:00.000Z');
const REPO = '/work/shop';

interface Started {
  command: string;
  args: readonly string[];
  env: NodeJS.ProcessEnv;
  /** The containment record as the seams would have read it while the agent ran. */
  recorded: SessionContainment | null;
}

interface RunSetup {
  home: string;
  args: string[];
  daemonPort?: number | null;
  platform?: string;
  familiar?: boolean;
}

/** A fake proxy: it listens on nothing, and says whether it was closed. */
function fakeProxy(port: number): {
  start: (o: EgressProxyOptions) => Promise<EgressProxy>;
  closed: () => boolean;
} {
  let closed = false;
  return {
    start: async () => ({ port, close: async () => void (closed = true) }),
    closed: () => closed,
  };
}

async function runWith(setup: RunSetup, proxy = fakeProxy(5555)) {
  const out = new RecordedOutput();
  const started: Started[] = [];
  const written: string[] = [];
  const program = new Command().exitOverride().configureOutput({ writeErr: () => {} });
  registerRunCommand(program, new CliContext(out, plainStyle), {
    home: () => setup.home,
    newId: () => 'ses_run',
    now: () => NOW,
    onPath: () => true,
    cwd: () => REPO,
    rootOf: () => REPO,
    familiarity: () => ({
      root: REPO,
      origin: 'git@github.com:stranger/shop.git',
      remembered: [],
      authored: setup.familiar === true,
    }),
    egress: { daemonPort: async () => setup.daemonPort ?? null, start: proxy.start },
    guard: {
      platform: setup.platform ?? 'darwin',
      kernel: '23.5.0',
      exists: () => false,
      write: (path) => void written.push(path),
    },
    start: (async (command: string, args: readonly string[], env: NodeJS.ProcessEnv) => {
      const recorded = await new SessionContainments(setup.home).read('ses_run');
      started.push({ command, args, env, recorded });
      return 0;
    }) as never,
  });
  await program.parseAsync(['run', '--no-milestone', ...setup.args], { from: 'user' });
  return { out, started, written, proxy };
}

async function home(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'memnox-run-containment-'));
}

describe('pointing the agent at the egress proxy', () => {
  it('sets every spelling the tools read, and never proxies loopback', () => {
    const env = proxyEnvironment('http://s:a@127.0.0.1:8888');
    for (const name of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'https_proxy']) {
      expect(env[name]).toBe('http://s:a@127.0.0.1:8888');
    }
    expect(env['NO_PROXY']).toContain('localhost');
    expect(env['NO_PROXY']).toContain('127.0.0.1');
    expect(env['NODE_USE_ENV_PROXY']).toBe('1');
  });

  it('uses the daemon’s proxy when one is running, with the session as its credentials', async () => {
    const { started, out } = await runWith({
      home: await home(),
      args: ['--', 'claude'],
      daemonPort: 8888,
    });
    expect(started[0]?.env['HTTPS_PROXY']).toBe(
      'http://ses_run:claude-code@127.0.0.1:8888',
    );
    expect(out.notes.join('\n')).toContain(
      'through the daemon egress proxy on port 8888',
    );
  });

  it('holds a proxy of its own when no daemon runs, and closes it when the agent exits', async () => {
    const { started, proxy } = await runWith({
      home: await home(),
      args: ['--', 'codex'],
    });
    expect(started[0]?.env['HTTP_PROXY']).toBe('http://ses_run:codex-cli@127.0.0.1:5555');
    expect(proxy.closed()).toBe(true);
  });

  it('records the session for the seams while it runs, and forgets it after', async () => {
    const dir = await home();
    const { started } = await runWith({
      home: dir,
      args: ['--', 'claude'],
      daemonPort: 8888,
    });
    expect(started[0]?.recorded).toMatchObject({
      root: REPO,
      untrusted: false,
      agent: 'claude-code',
    });
    expect(await new SessionContainments(dir).read('ses_run')).toBeNull();
  });
});

describe('memnox run --untrusted', () => {
  it('always holds its own proxy, even with a daemon running, and walls the agent in', async () => {
    const { started, written, out } = await runWith({
      home: await home(),
      args: ['--untrusted', '--', 'claude'],
      daemonPort: 8888,
    });
    const run = started[0];
    expect(run?.env['HTTPS_PROXY']).toContain(':5555');
    expect(run?.command).toBe('sandbox-exec');
    expect(run?.args.slice(-1)).toEqual(['claude']);
    expect(written[0]).toContain(join('guard', 'sessions', 'ses_run.sb'));
    expect(run?.recorded?.untrusted).toBe(true);
    expect(run?.env['npm_config_cache']).toContain('memnox-ses_run');
    expect(out.notes.join('\n')).toContain('outward and destructive actions ask');
  });

  it('refuses to start where no kernel can hold the wall, and lets go of its proxy', async () => {
    const proxy = fakeProxy(5555);
    await expect(
      runWith(
        { home: await home(), args: ['--untrusted', '--', 'claude'], platform: 'win32' },
        proxy,
      ),
    ).rejects.toThrow(/--untrusted needs a kernel sandbox[\s\S]*--no-guard/);
    expect(proxy.closed()).toBe(true);
  });

  it('runs with only the seams asking when the person says so', async () => {
    const { started } = await runWith({
      home: await home(),
      args: ['--untrusted', '--no-guard', '--', 'claude'],
      platform: 'win32',
    });
    expect(started[0]?.command).toBe('claude');
    expect(started[0]?.recorded?.untrusted).toBe(true);
  });
});

describe('the untrusted preset', () => {
  const preset = untrustedPreset({
    home: '/home/dev',
    workspace: REPO,
    temps: ['/private/tmp'],
    scratch: '/private/tmp/memnox-ses_1',
    binary: '/usr/local/bin/claude',
    proxyPort: 7777,
  });

  it('writes to the repository, temp and the Memnox ledger, and to nothing else in the home', () => {
    expect(preset.guard.writable).toEqual(
      expect.arrayContaining([
        REPO,
        '/private/tmp',
        '/private/tmp/memnox-ses_1',
        '/home/dev/.memnox',
      ]),
    );
    expect(preset.guard.writable.some((path) => path === '/home/dev')).toBe(false);
  });

  it('keeps the rules, the trust given and the answers to held calls out of the agent’s reach', () => {
    expect(preset.guard.unwritable).toEqual(
      expect.arrayContaining([
        '/home/dev/.memnox/pending',
        '/home/dev/.memnox/probation.json',
        '/home/dev/.memnox/policies.json',
        join(REPO, 'memnox.policies.toml'),
      ]),
    );
  });

  it('leaves the runtimes an agent starts from readable, but not the credentials beside them', () => {
    expect(preset.guard.readable).toEqual(
      expect.arrayContaining([
        '/home/dev/.nvm',
        '/home/dev/.cargo/bin',
        '/home/dev/.local/bin',
      ]),
    );
    expect(preset.guard.readable).not.toContain('/home/dev/.cargo');
  });

  it('leaves the agent its own state, and the keychains unreadable', () => {
    expect(preset.guard.statePrefixes).toEqual(['/home/dev/.claude']);
    expect(preset.guard.unreadable).toContain('/home/dev/Library/Keychains');
    expect(preset.guard.proxyPort).toBe(7777);
  });

  it('points package caches into the session’s temp, since the home is walled off', () => {
    expect(preset.env['PIP_CACHE_DIR']).toBe('/private/tmp/memnox-ses_1/pip_cache_dir');
  });
});

describe('the hint toward --untrusted', () => {
  const stranger = {
    root: REPO,
    origin: 'https://github.com/stranger/shop.git',
    remembered: [],
    authored: false,
  };

  it('is printed for a repository nobody here has worked in', async () => {
    const { out } = await runWith({
      home: await home(),
      args: ['--', 'claude'],
      daemonPort: 8888,
    });
    expect(out.notes.join('\n')).toContain('memnox run --untrusted -- <agent>');
    expect(untrustedHint(stranger)).toContain('github.com/stranger/shop');
  });

  it('is not printed where the person has commits', async () => {
    const { out } = await runWith({
      home: await home(),
      args: ['--', 'claude'],
      daemonPort: 8888,
      familiar: true,
    });
    expect(out.notes.join('\n')).not.toContain('--untrusted');
  });

  it('knows a repository by its origin, however the URL is spelled', () => {
    expect(normalizedOrigin('git@github.com:Acme/Shop.git')).toBe(
      normalizedOrigin('https://github.com/acme/shop'),
    );
    expect(
      isFamiliar({
        ...stranger,
        root: '/elsewhere/shop',
        origin: 'git@github.com:acme/shop.git',
        remembered: [{ root: '/work/shop', origin: 'https://github.com/acme/shop' }],
      }),
    ).toBe(true);
    expect(isFamiliar({ ...stranger, remembered: [{ root: REPO, origin: null }] })).toBe(
      true,
    );
    expect(isFamiliar(stranger)).toBe(false);
  });
});

describe('the daemon holding the egress proxy', () => {
  it('starts with the daemon, takes another port when 8888 is held, and says where', async () => {
    const dir = await home();
    const tried: number[] = [];
    const egress = new DaemonEgress(dir, {
      log: () => undefined,
      now: () => NOW,
      start: async (options) => {
        tried.push(options.port);
        if (options.port !== 0) throw new Error('EADDRINUSE');
        expect(options.seam).toBeInstanceOf(EgressSeam);
        return { port: 40123, close: async () => undefined };
      },
    });
    expect(await egress.start()).toBe(40123);
    expect(tried).toEqual([8888, 0]);
    expect(await daemonEgressPort(dir, () => true)).toBe(40123);
    // A daemon that died without stopping is not leaned on.
    expect(await daemonEgressPort(dir, () => false)).toBeNull();
  });

  it('stops with the daemon, closing the proxy and taking its port back', async () => {
    const dir = await home();
    const close = vi.fn(async () => undefined);
    const egress = new DaemonEgress(dir, {
      log: () => undefined,
      start: async () => ({ port: 8888, close }),
    });
    await egress.start();
    await egress.stop();
    expect(close).toHaveBeenCalledOnce();
    expect(existsSync(egressStatePath(dir))).toBe(false);
  });

  it('survives having no port at all, and says so', async () => {
    const said: string[] = [];
    const egress = new DaemonEgress(await home(), {
      log: (message) => void said.push(message),
      start: async () => {
        throw new Error('EACCES');
      },
    });
    expect(await egress.start()).toBeNull();
    expect(said.join('\n')).toContain('could not listen');
  });
});

describe('probation for what the keeper adopts', () => {
  it('starts per agent under the name the seams speak as, and per server', async () => {
    const dir = await home();
    const started = await startProbations(
      dir,
      [
        { kind: PROBATION_KIND.AGENT, agent: 'Codex' },
        { kind: PROBATION_KIND.MCP_SERVER, servers: ['slack'] },
      ],
      NOW,
    );
    expect([...started]).toEqual(['Codex', 'slack']);
    const names = (await new ProbationRegister(dir).all()).map((entry) => entry.name);
    expect(names).toEqual(['codex-cli', 'slack']);
  });

  it('says so in the notice a person reads', () => {
    expect(
      describeKept({ kind: KEPT_CHANGE.ADOPTED, agent: 'Cursor', probation: true }),
    ).toContain('on probation for 7 days');
    expect(
      describeKept({
        kind: KEPT_CHANGE.WRAPPED,
        servers: ['slack'],
        probation: ['slack'],
      }),
    ).toContain('slack: on probation for 7 days');
  });
});

describe('trusting something on probation', () => {
  async function trust(
    which: 'agents' | 'mcp',
    name: string,
    dir: string,
  ): Promise<string> {
    const out = new RecordedOutput();
    const program = new Command().exitOverride().configureOutput({ writeErr: () => {} });
    const context = new CliContext(out, plainStyle);
    if (which === 'agents') registerAgentsCommand(program, context, { home: () => dir });
    else registerMcpCommand(program, context, { home: () => dir });
    await program.parseAsync([which, 'trust', name], { from: 'user' });
    return [...out.lines, ...out.notes].join('\n');
  }

  it('ends an agent’s probation by either of its names', async () => {
    const dir = await home();
    await new ProbationRegister(dir).start(
      { kind: PROBATION_KIND.AGENT, name: 'codex-cli', label: 'Codex' },
      NOW,
    );
    expect(await trust('agents', 'Codex', dir)).toContain('Codex is trusted');
    const [entry] = await new ProbationRegister(dir).all();
    expect(entry?.trustedAt).toBeDefined();
  });

  it('ends a server’s probation', async () => {
    const dir = await home();
    await new ProbationRegister(dir).start(
      { kind: PROBATION_KIND.MCP_SERVER, name: 'slack' },
      NOW,
    );
    expect(await trust('mcp', 'slack', dir)).toContain('slack is trusted');
  });

  it('says plainly when there was nothing to end', async () => {
    expect(await trust('mcp', 'nobody', await home())).toContain('was ever on probation');
  });
});

describe('memnox status', () => {
  it('names what is on probation and until when', async () => {
    const out = new RecordedOutput();
    const program = new Command().exitOverride().configureOutput({ writeErr: () => {} });
    registerStatusCommand(program, new CliContext(out, plainStyle), {
      home: () => '/nowhere',
      project: () => '/nowhere',
      read: async () => ({
        setUp: true,
        mode: 'enforce',
        daemon: 'keeping',
        agents: 1,
        hooked: [],
        mcpServers: 1,
        mcpWrapped: 1,
        rules: 0,
        today: { actions: 0, asked: 0, denied: 0 },
        waiting: 0,
        paused: 0,
        workspace: null,
        dormant: [],
        probation: [
          {
            kind: PROBATION_KIND.MCP_SERVER,
            name: 'slack',
            since: NOW.toISOString(),
            until: '2026-10-01T10:00:00.000Z',
          },
        ],
      }),
    });
    await program.parseAsync(['status'], { from: 'user' });
    expect([...out.lines, ...out.notes].join('\n')).toContain('slack until 2026-10-01');
  });
});
