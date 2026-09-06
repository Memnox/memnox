import { describe, expect, it } from 'vitest';
import { discover, summarize } from '../src/discovery/discover';
import { CodexDetector } from '../src/discovery/detectors/codex-detector';
import {
  parseTomlTables,
  keyNamesAt,
  listAt,
} from '../src/discovery/detectors/toml-tables';
import { SURFACE_KIND } from '../src/discovery/discovery.constants';
import { inventoryOf } from '../src/discovery/inventory';
import { bandFor } from '../src/discovery/risk';
import { measureGap } from '../src/discovery/gap';
import { distinctTools } from '../src/discovery/surface';
import { FakeMachine } from './fake-machine';
import type { McpToolDeclaration } from '../src/discovery/surface';
import type { McpLister } from '../src/discovery/ports';

const NOW = '2026-09-06T09:00:00.000Z';

const CODEX_CONFIG = `# Codex writes TOML, and nothing else here does.
model = "o3"

[mcp_servers.github]
command = "npx"
args = [
  "-y",
  "@modelcontextprotocol/server-github",
]

[mcp_servers.github.env]
GITHUB_TOKEN = "ghp_realsecretvalue"

[mcp_servers.inline]
command = "uvx"
args = ["inline-mcp"]
env = { INLINE_TOKEN = "another_secret" }

[mcp_servers.off]
command = "npx"
enabled = false
`;

describe('the Codex detector', () => {
  const machine = (): FakeMachine =>
    FakeMachine.from({ '/home/dev/.codex/config.toml': CODEX_CONFIG });

  it('reads the servers Codex declares, which no JSON parser would find', async () => {
    const found = await new CodexDetector().detect(machine(), NOW);
    const mcp = found?.surfaces.find((each) => each.kind === SURFACE_KIND.MCP);

    expect(found?.agent.kind).toBe('codex-cli');
    expect(mcp?.servers?.map((each) => each.name).sort()).toEqual([
      'github',
      'inline',
      'off',
    ]);
  });

  it('joins an array written across several lines', async () => {
    const found = await new CodexDetector().detect(machine(), NOW);
    const github = found?.surfaces
      .find((each) => each.kind === SURFACE_KIND.MCP)
      ?.servers?.find((each) => each.name === 'github');

    expect(github?.args).toEqual(['-y', '@modelcontextprotocol/server-github']);
  });

  it('takes the credential name from either spelling, and never the value', async () => {
    const found = await new CodexDetector().detect(machine(), NOW);
    const servers = found?.surfaces.find(
      (each) => each.kind === SURFACE_KIND.MCP,
    )?.servers;

    expect(servers?.find((each) => each.name === 'github')?.env).toEqual([
      'GITHUB_TOKEN',
    ]);
    // An inline table is read for its keys, so the value never leaves the file.
    expect(servers?.find((each) => each.name === 'inline')?.env).toEqual([
      'INLINE_TOKEN',
    ]);
    expect(JSON.stringify(found)).not.toContain('ghp_realsecretvalue');
    expect(JSON.stringify(found)).not.toContain('another_secret');
    expect(servers?.find((each) => each.name === 'off')?.disabled).toBe(true);
  });

  it('is still an agent when it has a directory and no config yet', async () => {
    const found = await new CodexDetector().detect(
      FakeMachine.from({ '/home/dev/.codex': '' }),
      NOW,
    );

    expect(found?.agent.kind).toBe('codex-cli');
    expect(found?.surfaces.some((each) => each.kind === SURFACE_KIND.MCP)).toBe(false);
  });

  it('reads a comment marker inside a string as data', () => {
    const parsed = parseTomlTables('[a]\nargs = ["--header", "x#y"]\nenv = { K = "v" }');
    expect(listAt(parsed, 'a', 'args')).toEqual(['--header', 'x#y']);
    expect(keyNamesAt(parsed, 'a', 'env')).toEqual(['K']);
  });
});

/** The same server declared by every client on the machine, which is the normal case. */
const SHARED = JSON.stringify({
  mcpServers: { github: { command: 'npx', args: ['gh-mcp'] } },
});

const FIVE_CLIENTS = {
  '/home/dev/.claude.json': SHARED,
  '/home/dev/.cursor/mcp.json': SHARED,
  '/home/dev/.cline/settings.json': SHARED,
  '/home/dev/.vscode/mcp.json': SHARED,
  '/home/dev/.codex/config.toml':
    '[mcp_servers.github]\ncommand = "npx"\nargs = ["gh-mcp"]\n',
};

const DECLARED: McpToolDeclaration[] = [
  { name: 'get_issue' },
  { name: 'create_issue' },
  { name: 'delete_repo' },
];

class Lister implements McpLister {
  async listTools(): Promise<McpToolDeclaration[]> {
    return DECLARED;
  }
}

describe('one server, several clients', () => {
  const scan = async () =>
    discover(FakeMachine.from(FIVE_CLIENTS), { now: NOW, lister: new Lister() });

  it('counts a tool once, however many clients reach the server', async () => {
    const report = await scan();

    // Five clients declare it, so the surfaces hold fifteen copies of three tools.
    expect(report.surfaces.flatMap((each) => each.tools ?? [])).toHaveLength(15);
    expect(distinctTools(report.surfaces)).toHaveLength(3);
    expect(summarize(report).tools).toBe(3);
  });

  it('publishes one server row and one tool row each', async () => {
    const inventory = inventoryOf(await scan(), NOW);

    expect(inventory.mcpServers).toHaveLength(1);
    expect(inventory.mcpServers[0]?.reachedBy.sort()).toEqual([
      'agt_claude-code',
      'agt_cline',
      'agt_codex-cli',
      'agt_cursor',
      'agt_vscode',
    ]);
    expect(inventory.tools).toHaveLength(3);
  });

  it('does not multiply the risk band or the gap by the client count', async () => {
    const report = await scan();

    const destructive = bandFor(report).fired.find(
      (rule) => rule.rule === 'destructive-tool',
    );
    expect(destructive?.because).toBe('1 tool(s) can destroy or exfiltrate');
    // Two write-class actions, not ten: a duplicate action is not another action.
    expect(measureGap(report, []).total).toBe(2);
  });
});
