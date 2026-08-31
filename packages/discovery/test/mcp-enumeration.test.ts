import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { discover } from '../src/discover';
import { ConfigDetector } from '../src/detectors/config-detector';
import { LineBuffer, NodeMcpLister } from '../src/node-mcp-lister';
import { TOOL_EFFECT, EFFECT_INFERENCE } from '../src/discovery.constants';
import type { MachineReader, McpLister } from '../src/ports';
import type { McpToolDeclaration } from '../src/surface';

const NOW = '2026-01-01T00:00:00.000Z';

/** A server that answers `initialize` then `tools/list`, exactly as the protocol says. */
class FakeServer extends EventEmitter {
  readonly stdout = new EventEmitter();
  readonly written: string[] = [];
  readonly stdin = {
    write: (payload: string): boolean => {
      this.written.push(payload);
      const message = JSON.parse(payload) as { id?: number; method?: string };
      if (message.method === 'initialize') this.reply({ id: message.id, result: {} });
      if (message.method === 'tools/list') {
        this.reply({ id: message.id, result: { tools: this.tools } });
      }
      return true;
    },
  };
  killed = false;

  constructor(private readonly tools: unknown[]) {
    super();
  }

  private reply(message: unknown): void {
    // Answered on a later tick, as a real pipe would.
    queueMicrotask(() =>
      this.stdout.emit('data', Buffer.from(`${JSON.stringify(message)}\n`)),
    );
  }

  kill(): boolean {
    this.killed = true;
    return true;
  }
}

function listerFor(server: FakeServer): NodeMcpLister {
  return new NodeMcpLister({
    spawn: () => server as unknown as ChildProcess,
    timeoutMs: 500,
  });
}

describe('NodeMcpLister', () => {
  it('asks a server what it holds, because a config never says', async () => {
    const server = new FakeServer([
      { name: 'get_issue', description: 'read one issue' },
      { name: 'delete_repo', annotations: { destructiveHint: true } },
    ]);

    const tools = await listerFor(server).listTools('github', 'npx', ['-y', 'srv']);

    expect(tools.map((tool) => tool.name)).toEqual(['get_issue', 'delete_repo']);
    expect(server.killed).toBe(true);
  });

  it('speaks the handshake before it asks', async () => {
    const server = new FakeServer([]);
    await listerFor(server).listTools('github', 'npx', []);

    const methods = server.written.map(
      (line) => (JSON.parse(line) as { method?: string }).method,
    );
    expect(methods).toEqual(['initialize', 'notifications/initialized', 'tools/list']);
  });

  it('loses one malformed tool rather than the whole list', async () => {
    const server = new FakeServer([{ name: 'ok' }, null, { description: 'no name' }, 42]);
    const tools = await listerFor(server).listTools('s', 'cmd', []);
    expect(tools.map((tool) => tool.name)).toEqual(['ok']);
  });

  it('reports a server that will not start as absence, not as a crash', async () => {
    const lister = new NodeMcpLister({
      spawn: () => {
        throw new Error('ENOENT');
      },
    });
    await expect(lister.listTools('s', 'nope', [])).resolves.toEqual([]);
  });

  it('gives up on a silent server rather than holding the scan open', async () => {
    const silent = new FakeServer([]);
    silent.stdin.write = () => true; // Accepts everything, answers nothing.

    const tools = await new NodeMcpLister({
      spawn: () => silent as unknown as ChildProcess,
      timeoutMs: 20,
    }).listTools('s', 'cmd', []);

    expect(tools).toEqual([]);
    expect(silent.killed).toBe(true);
  });

  it('survives a server that prints noise on stdout', async () => {
    const server = new FakeServer([{ name: 'get_thing' }]);
    const lister = listerFor(server);
    const pending = lister.listTools('s', 'cmd', []);
    server.stdout.emit('data', Buffer.from('Listening on stdio\n'));
    await expect(pending).resolves.toHaveLength(1);
  });
});

describe('LineBuffer', () => {
  it('holds a partial write until the rest arrives', () => {
    const buffer = new LineBuffer();
    expect(buffer.push('{"a":')).toEqual([]);
    expect(buffer.push('1}\n{"b":2}\n')).toEqual(['{"a":1}', '{"b":2}']);
  });
});

/** Two clients, one of which declares MCP servers. */
class FakeMachine implements MachineReader {
  constructor(private readonly files: Record<string, string>) {}
  async exists(path: string): Promise<boolean> {
    return this.files[path] !== undefined;
  }
  async read(path: string): Promise<string | null> {
    return this.files[path] ?? null;
  }
  async list(): Promise<string[]> {
    return [];
  }
  homeDir(): string {
    return '/home/dev';
  }
  userName(): string {
    return 'dev';
  }
}

class StubLister implements McpLister {
  readonly asked: string[] = [];
  constructor(private readonly tools: Record<string, McpToolDeclaration[]>) {}
  async listTools(server: string): Promise<McpToolDeclaration[]> {
    this.asked.push(server);
    return this.tools[server] ?? [];
  }
}

const detector = new ConfigDetector({
  kind: 'claude-code',
  layoutVersion: '1',
  configPaths: ['.claude.json'],
  clients: ['Claude Code'],
  inherentSurfaces: ['shell'],
  mcpConfigPath: '.claude.json',
});

const CONFIG = JSON.stringify({
  mcpServers: {
    github: { command: 'npx', args: ['-y', '@mcp/github'] },
    postgres: { command: 'npx', args: ['-y', '@mcp/postgres'] },
  },
});

describe('discover, enumerating tools', () => {
  const machine = new FakeMachine({ '/home/dev/.claude.json': CONFIG });

  it('reports the servers with no tools when nobody asked them', async () => {
    const report = await discover(machine, { now: NOW, detectors: [detector] });
    const mcp = report.surfaces.find((surface) => surface.kind === 'mcp');

    expect(mcp?.servers?.map((server) => server.name)).toEqual(['github', 'postgres']);
    expect(mcp?.tools).toEqual([]);
    expect(report.probed).toEqual([]);
  });

  it('fills in every tool, and what each one does', async () => {
    const lister = new StubLister({
      github: [{ name: 'get_issue' }, { name: 'delete_repo' }],
      postgres: [{ name: 'query' }],
    });

    const report = await discover(machine, {
      now: NOW,
      detectors: [detector],
      lister,
    });
    const tools = report.surfaces.find((surface) => surface.kind === 'mcp')?.tools ?? [];

    expect(lister.asked).toEqual(['github', 'postgres']);
    expect(tools).toHaveLength(3);
    expect(tools.find((tool) => tool.name === 'delete_repo')).toMatchObject({
      server: 'github',
      effect: TOOL_EFFECT.DESTRUCTIVE,
      inferredFrom: EFFECT_INFERENCE.NAME,
    });
  });

  it('names what it started, so the probe is itself inspectable', async () => {
    const report = await discover(machine, {
      now: NOW,
      detectors: [detector],
      lister: new StubLister({}),
    });

    expect(report.probed).toEqual([
      'github: npx -y @mcp/github',
      'postgres: npx -y @mcp/postgres',
    ]);
  });

  it('loses one unstartable server’s tools and nobody else’s', async () => {
    const report = await discover(machine, {
      now: NOW,
      detectors: [detector],
      lister: new StubLister({ postgres: [{ name: 'query' }] }),
    });
    const tools = report.surfaces.find((surface) => surface.kind === 'mcp')?.tools ?? [];

    expect(tools.map((tool) => tool.name)).toEqual(['query']);
  });
});

describe('discover, beyond the home directory', () => {
  const AWS = ['[default]\naws_access_key_id = AKIA', 'EXAMPLE'].join('');
  const machine = new FakeMachine({
    '/home/dev/.claude.json': CONFIG,
    '/home/dev/.aws/credentials': AWS,
    '/srv/checkout/.env': 'DATABASE_URL=postgres://localhost/app',
    '/srv/checkout/.env.production': 'STRIPE_KEY=sk_live_x',
    '/srv/checkout/.git': '',
  });

  it('finds the credentials a repository has, not only the ones a person has', async () => {
    const report = await discover(machine, {
      now: NOW,
      detectors: [detector],
      projectDirs: ['/srv/checkout'],
    });

    const paths = report.resources.map((resource) => resource.path);
    expect(paths).toContain('/home/dev/.aws/credentials');
    expect(paths).toContain('/srv/checkout/.env');
    expect(paths).toContain('/srv/checkout/.env.production');
  });

  it('counts a checkout as a resource without opening it', async () => {
    const report = await discover(machine, {
      now: NOW,
      detectors: [detector],
      projectDirs: ['/srv/checkout'],
    });

    const repo = report.resources.find((each) => each.path === '/srv/checkout/.git');
    expect(repo?.kind).toBe('repo');
    // Not opened, so nothing was fingerprinted and nothing was read.
    expect(repo?.fingerprint).toBeUndefined();
    expect(report.read).not.toContain('/srv/checkout/.git');
  });

  /** The value stays in the process that read it: only a hash ever leaves. */
  it('fingerprints a project credential and never keeps it', async () => {
    const report = await discover(machine, {
      now: NOW,
      detectors: [detector],
      projectDirs: ['/srv/checkout'],
    });

    const env = report.resources.find((each) => each.path === '/srv/checkout/.env');
    expect(env?.fingerprint).toBeDefined();
    expect(JSON.stringify(report)).not.toContain('postgres://localhost/app');
  });

  it('names every file it opened, so the scan is itself inspectable', async () => {
    const report = await discover(machine, {
      now: NOW,
      detectors: [detector],
      projectDirs: ['/srv/checkout'],
    });
    expect(report.read).toContain('/srv/checkout/.env');
  });

  it('counts a directory named twice only once', async () => {
    const report = await discover(machine, {
      now: NOW,
      detectors: [detector],
      projectDirs: ['/srv/checkout', '/srv/checkout'],
    });
    const envs = report.resources.filter((each) => each.path === '/srv/checkout/.env');
    expect(envs).toHaveLength(1);
  });

  it('reads a directory with nothing in it as nothing, not as an error', async () => {
    const report = await discover(machine, {
      now: NOW,
      detectors: [detector],
      projectDirs: ['/srv/empty'],
    });
    expect(report.resources.map((each) => each.path)).not.toContain('/srv/empty/.env');
  });
});
