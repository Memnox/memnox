import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MemnoxClient } from '@memnox/sdk';
import { McpServer, LineBuffer, parseMessage } from '../src/mcp/mcp-server';
import { MCP_TOOLS, TOOL_RULES, TOOL_STATUS, callTool } from '../src/mcp/mcp-tools';
import { McpInstaller, MCP_CLIENT, MEMNOX_SERVER_KEY } from '../src/mcp-installer';
import { FakeRuntime } from './cli-harness';

const CONTEXT_PATH = '/v1/context';
const POLICIES_PATH = '/v1/policies';
const APPROVALS_PATH = '/v1/approvals';
const RUNTIME_URL = 'http://127.0.0.1:7466';

const serverFor = (runtime: FakeRuntime): McpServer =>
  new McpServer({
    client: new MemnoxClient({
      baseUrl: RUNTIME_URL,
      token: 'mnx_t',
      fetch: runtime.transport,
    }),
    runtimeUrl: RUNTIME_URL,
  });

const call = (id: number, name: string, args: Record<string, unknown> = {}) => ({
  jsonrpc: '2.0' as const,
  id,
  method: 'tools/call',
  params: { name, arguments: args },
});

describe('McpServer protocol', () => {
  it('announces itself and its tool capability on initialize', async () => {
    const reply = await serverFor(new FakeRuntime()).handle({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {},
    });

    expect(reply?.result?.['serverInfo']).toMatchObject({ name: 'memnox' });
    expect(reply?.result?.['capabilities']).toMatchObject({ tools: {} });
  });

  it('says nothing back to a notification', async () => {
    const reply = await serverFor(new FakeRuntime()).handle({
      jsonrpc: '2.0',
      method: 'notifications/initialized',
    });

    expect(reply).toBeNull();
  });

  it('lists exactly the two tools an agent needs', async () => {
    const reply = await serverFor(new FakeRuntime()).handle({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list',
    });

    const tools = reply?.result?.['tools'] as Array<{ name: string }>;
    expect(tools.map((tool) => tool.name)).toEqual([TOOL_RULES, TOOL_STATUS]);
  });

  it('rejects a method it does not implement', async () => {
    const reply = await serverFor(new FakeRuntime()).handle({
      jsonrpc: '2.0',
      id: 3,
      method: 'resources/list',
    });

    expect(reply?.error).toMatchObject({ code: -32601 });
  });
});

describe('memnox_check_rules', () => {
  it('returns the briefing text the runtime rendered', async () => {
    const runtime = new FakeRuntime().on('POST', CONTEXT_PATH, {
      briefing: { constraints: [], security: [] },
      text: 'Memnox constraints for "file.write src/auth/session.ts"',
    });

    const reply = await serverFor(runtime).handle(
      call(4, TOOL_RULES, { action: 'file.write', target: 'src/auth/session.ts' }),
    );

    const content = reply?.result?.['content'] as Array<{ text: string }>;
    expect(content[0]?.text).toContain('file.write src/auth/session.ts');
    expect(reply?.result?.['isError']).toBe(false);
  });

  it('asks for the action instead of failing silently', async () => {
    const reply = await serverFor(new FakeRuntime()).handle(call(5, TOOL_RULES, {}));

    const content = reply?.result?.['content'] as Array<{ text: string }>;
    expect(content[0]?.text).toContain('Which action?');
    expect(reply?.result?.['isError']).toBe(true);
  });

  it('tells the model how to fix a runtime that is not running', async () => {
    const result = await callTool(
      TOOL_RULES,
      { action: 'file.write' },
      {
        client: new MemnoxClient({
          baseUrl: RUNTIME_URL,
          fetch: async () => {
            throw new Error('fetch failed');
          },
        }),
        runtimeUrl: RUNTIME_URL,
      },
    );

    expect(result.isError).toBe(true);
    expect(result.text).toContain('memnox serve');
  });

  it('reports an unknown tool as a result, not a protocol error', async () => {
    const reply = await serverFor(new FakeRuntime()).handle(call(6, 'memnox_invented'));

    expect(reply?.error).toBeUndefined();
    expect(reply?.result?.['isError']).toBe(true);
  });
});

describe('memnox_status', () => {
  it('summarises rules in force and what is waiting', async () => {
    const runtime = new FakeRuntime()
      .on('GET', POLICIES_PATH, { policies: [{ name: 'a' }], version: 'v9' })
      .on('GET', APPROVALS_PATH, [
        { id: 'apr_1', action: 'deploy.service', target: 'api', approvers: ['eng-lead'] },
      ]);

    const reply = await serverFor(runtime).handle(call(7, TOOL_STATUS));
    const content = reply?.result?.['content'] as Array<{ text: string }>;

    expect(content[0]?.text).toContain('1 rule(s) in force');
    expect(content[0]?.text).toContain('deploy.service api');
  });
});

describe('tool descriptions', () => {
  it('tell a model when to call them, since that is the whole interface', () => {
    for (const tool of MCP_TOOLS) {
      expect(tool.description.length).toBeGreaterThan(80);
      expect(tool.inputSchema['type']).toBe('object');
    }
  });
});

describe('LineBuffer', () => {
  it('holds a partial line until its newline arrives', () => {
    const buffer = new LineBuffer();

    expect(buffer.push('{"a":')).toEqual([]);
    expect(buffer.push('1}\n')).toEqual(['{"a":1}']);
  });

  it('drops a malformed line rather than killing the session', () => {
    expect(parseMessage('not json')).toBeNull();
  });
});

describe('McpInstaller', () => {
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'memnox-mcp-'));
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  const claudeConfig = async (): Promise<Record<string, unknown>> =>
    JSON.parse(await readFile(join(home, '.claude.json'), 'utf8')) as Record<
      string,
      unknown
    >;

  it('registers the server with absolute paths a GUI client can launch', async () => {
    const report = await new McpInstaller(home).install(MCP_CLIENT.CLAUDE_CODE);

    expect(report.installed).toBe(true);
    const servers = (await claudeConfig())['mcpServers'] as Record<
      string,
      { command: string; args: string[] }
    >;
    expect(servers[MEMNOX_SERVER_KEY]?.command.startsWith('/')).toBe(true);
    expect(servers[MEMNOX_SERVER_KEY]?.args).toContain('mcp');
  });

  it('keeps the other servers in the config untouched', async () => {
    await writeFile(
      join(home, '.claude.json'),
      JSON.stringify({ mcpServers: { other: { command: 'x' } }, theme: 'dark' }),
      'utf8',
    );

    await new McpInstaller(home).install(MCP_CLIENT.CLAUDE_CODE);

    const config = await claudeConfig();
    expect(config['theme']).toBe('dark');
    expect(Object.keys(config['mcpServers'] as object)).toEqual(['other', 'memnox']);
  });

  it('never overwrites an entry someone put there deliberately', async () => {
    await writeFile(
      join(home, '.claude.json'),
      JSON.stringify({ mcpServers: { memnox: { command: 'custom' } } }),
      'utf8',
    );

    const report = await new McpInstaller(home).install(MCP_CLIENT.CLAUDE_CODE);

    expect(report.installed).toBe(false);
    const servers = (await claudeConfig())['mcpServers'] as Record<
      string,
      { command: string }
    >;
    expect(servers[MEMNOX_SERVER_KEY]?.command).toBe('custom');
  });

  it('removes only its own entry', async () => {
    await writeFile(
      join(home, '.claude.json'),
      JSON.stringify({ mcpServers: { other: { command: 'x' } } }),
      'utf8',
    );
    const installer = new McpInstaller(home);
    await installer.install(MCP_CLIENT.CLAUDE_CODE);

    expect(await installer.uninstall(MCP_CLIENT.CLAUDE_CODE)).toBe(true);
    expect(Object.keys((await claudeConfig())['mcpServers'] as object)).toEqual([
      'other',
    ]);
  });

  it('refuses a client it does not support', async () => {
    await expect(new McpInstaller(home).install('emacs')).rejects.toThrow(
      /expected one of/,
    );
  });
});
