import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Command } from 'commander';
import type { RuntimeConfig } from '@memnox/runtime';
import { agentConfigPath, readAgentConfig, writeAgentConfig } from '../src/agent-config';
import { CliContext } from '../src/cli-context';
import { RecordedOutput } from '../src/cli-output';
import { registerSetupCommand } from '../src/commands/setup.command';
import type { ServerLauncher } from '../src/commands/serve.command';
import type { EditorHookInstaller } from '../src/editor-hook-installer';
import { McpInstaller, MEMNOX_SERVER_KEY } from '../src/mcp-installer';
import { DEFAULT_CODE_GRAPH_FILE } from '../src/defaults';
import { parse } from 'yaml';
import { validatePolicyDocument } from '@memnox/policy-engine';
import { FakeRuntime } from './cli-harness';

const AGENTS_PATH = '/v1/agents';

const registration = (token: string): Record<string, unknown> => ({
  agent: { id: 'agt_1', name: 'local-editor', kind: 'custom' },
  token,
});

describe('memnox setup', () => {
  let workspace: string;
  let home: string;
  let out: RecordedOutput;
  let detectCalls: number;
  let launched: Partial<RuntimeConfig>[];
  let detected: { agent: string; path: string; installed: boolean }[];
  let runtime: FakeRuntime;
  let alreadyRunning: boolean;
  let probed: string[];

  const run = async (args: string[]): Promise<void> => {
    const program = new Command();
    program.exitOverride();
    const installer = {
      installDetected: async () => {
        detectCalls += 1;
        return detected;
      },
    } as unknown as EditorHookInstaller;
    const launch: ServerLauncher = async (overrides) => {
      launched.push(overrides);
      return {
        config: {
          host: overrides.host ?? '127.0.0.1',
          port: overrides.port ?? 7466,
        } as RuntimeConfig,
      };
    };
    registerSetupCommand(
      program,
      new CliContext(out, runtime.transport),
      installer,
      launch,
      home,
      async (url) => {
        probed.push(url);
        return alreadyRunning;
      },
      new McpInstaller(home),
    );
    await program.parseAsync(['node', 'memnox', 'setup', ...args]);
  };

  const onlyLaunch = (): Partial<RuntimeConfig> => {
    const first = launched[0];
    if (first === undefined) throw new Error('the runtime was never launched');
    return first;
  };

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), 'memnox-setup-'));
    home = await mkdtemp(join(tmpdir(), 'memnox-home-'));
    out = new RecordedOutput();
    detectCalls = 0;
    launched = [];
    detected = [{ agent: 'claude-code', path: '/fake', installed: true }];
    runtime = new FakeRuntime().on('POST', AGENTS_PATH, registration('mnx_new'));
    alreadyRunning = false;
    probed = [];
  });

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  });

  it('scaffolds policies, installs detected hooks, and starts the runtime', async () => {
    const file = join(workspace, 'policies.yaml');
    await run(['--file', file]);

    expect(await readFile(file, 'utf8')).toContain('production-database-protection');
    expect(detectCalls).toBe(1);
    expect(onlyLaunch().policyFile).toBe(file);
    expect(out.text).toContain('Installed the claude-code hook');
    expect(out.text).toContain('Memnox runtime listening on');
  });

  it('registers an agent and stores the token where the hook can read it', async () => {
    await run(['--file', join(workspace, 'policies.yaml')]);

    const stored = await readAgentConfig(home);
    expect(stored.token).toBe('mnx_new');
    expect(stored.url).toBe('http://127.0.0.1:7466');
    expect(out.text).toContain(`token saved to ${agentConfigPath(home)}`);
  });

  it('keeps the credential file readable only by its owner', async () => {
    await run(['--file', join(workspace, 'policies.yaml')]);

    const mode = (await stat(agentConfigPath(home))).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('tells the user to restart the editor it just hooked', async () => {
    await run(['--file', join(workspace, 'policies.yaml')]);

    expect(out.notes.join('\n')).toContain('Restart your editor');
  });

  it('reuses an existing token instead of minting a second identity', async () => {
    await writeAgentConfig(home, { token: 'mnx_existing', url: 'http://127.0.0.1:7466' });

    await run(['--file', join(workspace, 'policies.yaml')]);

    expect(runtime.requests).toHaveLength(0);
    expect((await readAgentConfig(home)).token).toBe('mnx_existing');
    expect(out.notes.join('\n')).toContain('Using the agent token already at');
  });

  it('refreshes the stored URL when the runtime moves port', async () => {
    await writeAgentConfig(home, { token: 'mnx_existing', url: 'http://127.0.0.1:7466' });

    await run(['--file', join(workspace, 'policies.yaml'), '--port', '7479']);

    const stored = await readAgentConfig(home);
    expect(stored.token).toBe('mnx_existing');
    expect(stored.url).toBe('http://127.0.0.1:7479');
  });

  it('keeps serving when registration fails rather than dying', async () => {
    runtime = new FakeRuntime(); // POST /v1/agents 404s

    await run(['--file', join(workspace, 'policies.yaml')]);

    expect(launched).toHaveLength(1);
    expect(out.text).toContain('Memnox runtime listening on');
    expect(out.notes.join('\n')).toContain('Could not register the editor agent');
    expect(out.notes.join('\n')).toContain('hooks stay inactive');
  });

  it('observes rather than blocks on a first run', async () => {
    await run(['--file', join(workspace, 'policies.yaml')]);

    expect(onlyLaunch().enforcement).toEqual({ default: 'monitor' });
    expect(out.text).toContain('Observing only');
    expect(out.notes.join('\n')).toContain('memnox setup --enforce');
  });

  it('blocks from the first request under --enforce', async () => {
    await run(['--file', join(workspace, 'policies.yaml'), '--enforce']);

    expect(onlyLaunch().enforcement).toBeUndefined();
    expect(out.text).toContain('Enforcing');
  });

  it('never overwrites rules someone already wrote', async () => {
    const file = join(workspace, 'policies.yaml');
    await writeFile(file, 'version: 1\npolicies: []\n', 'utf8');

    await run(['--file', file]);

    expect(await readFile(file, 'utf8')).toBe('version: 1\npolicies: []\n');
    expect(out.notes.join('\n')).toContain('Keeping the policy file already at');
  });

  it('scaffolds without binding a port or registering under --no-serve', async () => {
    const file = join(workspace, 'policies.yaml');
    await run(['--file', file, '--no-serve']);

    expect(launched).toHaveLength(0);
    expect(runtime.requests).toHaveLength(0);
    expect(out.text).toContain(`memnox serve --policies ${file}`);
  });

  it('probes the address it is about to bind before starting anything', async () => {
    await run(['--file', join(workspace, 'policies.yaml'), '--port', '7479']);

    expect(probed).toEqual(['http://127.0.0.1:7479']);
  });

  it('skips editor hooks under --no-hook', async () => {
    await run(['--file', join(workspace, 'policies.yaml'), '--no-hook']);

    expect(detectCalls).toBe(0);
    expect(launched).toHaveLength(1);
  });

  it('says so when no editor is installed rather than failing', async () => {
    detected = [];
    await run(['--file', join(workspace, 'policies.yaml')]);

    expect(out.notes.join('\n')).toContain('No Claude Code or Cursor config found');
    expect(out.notes.join('\n')).not.toContain('Restart your editor');
    expect(launched).toHaveLength(1);
  });
});

describe('memnox setup — a second repository', () => {
  let workspace: string;
  let home: string;
  let out: RecordedOutput;
  let launched: Partial<RuntimeConfig>[];
  let alreadyRunning: boolean;
  let runtime: FakeRuntime;

  const run = async (args: string[]): Promise<void> => {
    const program = new Command();
    program.exitOverride();
    const installer = {
      installDetected: async () => [
        { agent: 'claude-code', path: '/fake', installed: false },
      ],
    } as unknown as EditorHookInstaller;
    const launch: ServerLauncher = async (overrides) => {
      launched.push(overrides);
      return {
        config: { host: '127.0.0.1', port: overrides.port ?? 7466 } as RuntimeConfig,
      };
    };
    registerSetupCommand(
      program,
      new CliContext(out, runtime.transport),
      installer,
      launch,
      home,
      async () => alreadyRunning,
    );
    await program.parseAsync(['node', 'memnox', 'setup', ...args]);
  };

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), 'memnox-second-'));
    home = await mkdtemp(join(tmpdir(), 'memnox-home2-'));
    out = new RecordedOutput();
    launched = [];
    alreadyRunning = true; // a runtime from the first repo is already up
    runtime = new FakeRuntime().on('POST', AGENTS_PATH, registration('mnx_new'));
    await writeAgentConfig(home, { token: 'mnx_first', url: 'http://127.0.0.1:7466' });
  });

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  });

  it('joins the running runtime instead of fighting it for the port', async () => {
    await run(['--file', join(workspace, 'policies.yaml')]);

    expect(launched).toHaveLength(0);
    expect(out.text).toContain('Using the runtime already on http://127.0.0.1:7466');
  });

  it('declares the project so both repos share one scope', async () => {
    const file = join(workspace, 'policies.yaml');
    await run(['--file', file, '--project', 'acme-checkout']);

    expect(await readFile(file, 'utf8')).toContain('project: acme-checkout');
    expect(out.text).toContain('Project: acme-checkout');
  });

  it('writes a policy file that still parses as a valid document', async () => {
    const file = join(workspace, 'policies.yaml');
    await run(['--file', file, '--project', 'acme-checkout']);

    const parsed = parse(await readFile(file, 'utf8')) as Record<string, unknown>;
    expect(validatePolicyDocument(parsed).project).toBe('acme-checkout');
  });

  it('arms a runtime it did not start, rather than asking for a restart', async () => {
    runtime.on('PUT', '/v1/enforcement', { applied: true });

    await run(['--file', join(workspace, 'policies.yaml'), '--enforce']);

    const change = runtime.requests.find(
      (request) => request.method === 'PUT' && request.path === '/v1/enforcement',
    );
    expect(change?.body).toEqual({ default: 'enforce' });
    expect(out.notes.join('\n')).toContain('Enforcing now');
  });

  it('says so when it cannot change the mode, instead of claiming it did', async () => {
    // No stub for the route, so the runtime refuses it, as a tokened one would.
    await run(['--file', join(workspace, 'policies.yaml'), '--enforce']);

    expect(out.notes.join('\n')).toContain('Could not change its mode');
  });

  it('starts a runtime when nothing answers', async () => {
    alreadyRunning = false;

    await run(['--file', join(workspace, 'policies.yaml')]);

    expect(launched).toHaveLength(1);
    expect(out.text).toContain('Memnox runtime listening on');
  });

  it('flags a policy file that declares a different project', async () => {
    const file = join(workspace, 'memnox.policies.yaml');
    await writeFile(file, 'project: billing-service\nversion: 1\npolicies: []\n', 'utf8');

    await run(['--file', file, '--project', 'acme-checkout']);

    expect(out.notes.join('\n')).toContain('declares project "billing-service"');
  });

  it('tells the user how to join the scope when a file declares none', async () => {
    const file = join(workspace, 'memnox.policies.yaml');
    await writeFile(file, 'version: 1\npolicies: []\n', 'utf8');

    await run(['--file', file, '--project', 'acme-checkout']);

    expect(out.notes.join('\n')).toContain('add "project: acme-checkout"');
  });
});

describe('security a local install gets by default', () => {
  let workspace: string;
  let home: string;
  let out: RecordedOutput;
  let launched: Partial<RuntimeConfig>[];
  let runtime: FakeRuntime;

  const run = async (args: string[]): Promise<void> => {
    const program = new Command();
    program.exitOverride();
    const installer = {
      installDetected: async () => [],
    } as unknown as EditorHookInstaller;
    const launch: ServerLauncher = async (overrides) => {
      launched.push(overrides);
      return {
        config: {
          host: overrides.host ?? '127.0.0.1',
          port: overrides.port ?? 7466,
        } as RuntimeConfig,
      };
    };
    registerSetupCommand(
      program,
      new CliContext(out, runtime.transport),
      installer,
      launch,
      home,
      async () => false,
      new McpInstaller(home),
    );
    await program.parseAsync(['node', 'memnox', 'setup', ...args]);
  };

  const mcpServers = async (): Promise<Record<string, unknown>> => {
    const config = JSON.parse(await readFile(join(home, '.claude.json'), 'utf8')) as {
      mcpServers?: Record<string, unknown>;
    };
    return config.mcpServers ?? {};
  };

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), 'memnox-guards-'));
    home = await mkdtemp(join(tmpdir(), 'memnox-guards-home-'));
    out = new RecordedOutput();
    launched = [];
    runtime = new FakeRuntime().on('POST', AGENTS_PATH, registration('mnx_new'));
    // A client config is the only signal the installer has that a client exists.
    await writeFile(join(home, '.claude.json'), '{}', 'utf8');
    process.chdir(workspace);
  });

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  });

  it('turns on every deterministic guard', async () => {
    await run([]);

    // Safe because the first run observes: a guard that fires is an audit line,
    // not a blocked editor.
    expect(launched[0]).toMatchObject({
      behaviorGuard: true,
      trustGuard: true,
      verificationGuard: true,
      dependencyGuard: true,
    });
  });

  it('reports what is guarding, so nobody has to guess', async () => {
    await run([]);

    expect(out.text).toContain('Guards:');
    expect(out.text).toContain('dependencies');
  });

  it('registers the MCP server, so the agent can ask before it writes', async () => {
    await run([]);

    expect((await mcpServers())[MEMNOX_SERVER_KEY]).toBeDefined();
    expect(out.text).toContain('Registered the Memnox MCP server');
  });

  it('skips the MCP server when asked', async () => {
    await run(['--no-mcp']);

    expect((await mcpServers())[MEMNOX_SERVER_KEY]).toBeUndefined();
  });

  it('still registers it when scaffolding without a runtime', async () => {
    await run(['--no-serve']);

    expect((await mcpServers())[MEMNOX_SERVER_KEY]).toBeDefined();
    expect(launched).toHaveLength(0);
  });

  it('builds the code graph and hands it to the runtime', async () => {
    await writeFile(join(workspace, 'money.ts'), 'export const round = 1;\n', 'utf8');
    await writeFile(
      join(workspace, 'checkout.ts'),
      "import { round } from './money';\n",
      'utf8',
    );

    await run([]);

    // Blast radius is unreachable without both halves; setup does both.
    expect(launched[0]?.codeGraphFile).toBe(DEFAULT_CODE_GRAPH_FILE);
    expect(out.text).toContain('Code graph:');
    const snapshot = JSON.parse(
      await readFile(join(workspace, DEFAULT_CODE_GRAPH_FILE), 'utf8'),
    ) as { files?: unknown[]; edges?: unknown[] };
    expect(snapshot.files).toHaveLength(2);
    expect(snapshot.edges).toHaveLength(1);
  });

  it('skips the graph when asked, and still starts', async () => {
    await run(['--no-graph']);

    expect(launched[0]?.codeGraphFile).toBeUndefined();
    expect(launched).toHaveLength(1);
  });

  it('starts anyway when there is nothing to graph', async () => {
    await run([]);

    // An empty repository is not a reason to refuse to govern it.
    expect(launched).toHaveLength(1);
    expect(launched[0]?.codeGraphFile).toBeUndefined();
  });

  it('arms blast radius on the sensitive directories it graphed', async () => {
    await mkdir(join(workspace, 'payment'), { recursive: true });
    await writeFile(join(workspace, 'payment', 'charge.ts'), 'export const c = 1;\n');
    await writeFile(join(workspace, 'app.ts'), "import './payment/charge';\n");

    await run([]);

    // A graph without protected paths registers no advisor at all: the guard
    // looks configured and can never fire.
    expect(launched[0]?.protectedPaths).toEqual(['*payment/*']);
    expect(out.text).toContain('*payment/*');
  });

  it('lets --protected-path override what it detected', async () => {
    await mkdir(join(workspace, 'payment'), { recursive: true });
    await writeFile(join(workspace, 'payment', 'charge.ts'), 'export const c = 1;\n');

    await run(['--protected-path', 'app/*']);

    expect(launched[0]?.protectedPaths).toEqual(['app/*']);
  });

  it('collects a repeated --protected-path', async () => {
    await writeFile(join(workspace, 'app.ts'), 'export const a = 1;\n');

    await run(['--protected-path', 'app/*', '--protected-path', 'db/*']);

    expect(launched[0]?.protectedPaths).toEqual(['app/*', 'db/*']);
  });

  it('says the guard is off rather than implying a graph is enough', async () => {
    await writeFile(join(workspace, 'app.ts'), 'export const a = 1;\n');

    await run([]);

    expect(launched[0]?.protectedPaths).toBeUndefined();
    expect(out.text).toContain('no protected paths found');
  });
});
