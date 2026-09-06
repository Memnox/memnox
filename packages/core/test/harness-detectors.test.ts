import { describe, expect, it } from 'vitest';
import { discover } from '../src/discovery/discover';
import { alertsFor } from '../src/discovery/alerts';
import { compareSnapshots, snapshotOf } from '../src/discovery/snapshot';
import { HermesDetector } from '../src/discovery/detectors/hermes-detector';
import { OpenClawDetector } from '../src/discovery/detectors/openclaw-detector';
import { RufloDetector } from '../src/discovery/detectors/ruflo-detector';
import { SURFACE_KIND } from '../src/discovery/discovery.constants';
import { FILTER_PRECEDENCE, passesFilter } from '../src/discovery/surface';
import { FakeMachine } from './fake-machine';

const NOW = '2026-09-06T09:00:00.000Z';

const HERMES_CONFIG = `# the agent's own config
model: claude-opus-5
mcp_servers:
  github:
    command: "npx"
    args: ["-y", "@modelcontextprotocol/server-github"]
    env:
      GITHUB_TOKEN: "ghp_realsecretvalue"
    tools:
      include: [list_issues, create_issue]
      exclude: [delete_repo]
  stripe:
    command: uvx
    args:
      - stripe-mcp
    tools:
      exclude:
        - refund_payment
  archived:
    command: npx
    args: ["old-server"]
    enabled: false
  remote:
    url: "https://mcp.example.com/mcp"
agents:
  planner:
    model: haiku
  deployer:
    model: opus
`;

describe('the Hermes detector', () => {
  it('reads the servers out of YAML, and never a value it was handed', async () => {
    const machine = FakeMachine.from({ '/home/dev/.hermes/config.yaml': HERMES_CONFIG });

    const found = await new HermesDetector().detect(machine, NOW);
    const mcp = found?.surfaces.find((each) => each.kind === SURFACE_KIND.MCP);

    expect(found?.agent.kind).toBe('hermes');
    expect(mcp?.servers?.map((each) => each.name).sort()).toEqual([
      'archived',
      'github',
      'remote',
      'stripe',
    ]);
    const github = mcp?.servers?.find((each) => each.name === 'github');
    expect(github?.args).toEqual(['-y', '@modelcontextprotocol/server-github']);
    // The name of the credential travels; the credential itself never does.
    expect(github?.env).toEqual(['GITHUB_TOKEN']);
    expect(JSON.stringify(found)).not.toContain('ghp_realsecretvalue');
  });

  it('keeps the filter Hermes already applies, in both spellings', async () => {
    const machine = FakeMachine.from({ '/home/dev/.hermes/config.yaml': HERMES_CONFIG });

    const found = await new HermesDetector().detect(machine, NOW);
    const servers = found?.surfaces.find(
      (each) => each.kind === SURFACE_KIND.MCP,
    )?.servers;

    expect(servers?.find((each) => each.name === 'github')?.filter).toEqual({
      include: ['list_issues', 'create_issue'],
      exclude: ['delete_repo'],
      precedence: 'include-wins',
    });
    /* A block sequence and an inline list are the same list — and `include` is absent
       here rather than empty, which in Hermes is the difference between "no whitelist"
       and "a whitelist that admits nothing". */
    expect(servers?.find((each) => each.name === 'stripe')?.filter).toEqual({
      exclude: ['refund_payment'],
      precedence: 'include-wins',
    });
  });

  it('marks a server its own config switched off, rather than reporting reach', async () => {
    const machine = FakeMachine.from({ '/home/dev/.hermes/config.yaml': HERMES_CONFIG });

    const found = await new HermesDetector().detect(machine, NOW);
    const servers = found?.surfaces.find(
      (each) => each.kind === SURFACE_KIND.MCP,
    )?.servers;

    expect(servers?.find((each) => each.name === 'archived')?.disabled).toBe(true);
    expect(servers?.find((each) => each.name === 'github')?.disabled).toBeUndefined();
  });

  it('names the roles it launches, so a harness is not counted as one agent', async () => {
    const machine = FakeMachine.from({ '/home/dev/.hermes/config.yaml': HERMES_CONFIG });

    const found = await new HermesDetector().detect(machine, NOW);

    expect(found?.hosted?.roles.sort()).toEqual(['deployer', 'planner']);
  });

  it('says nothing when the machine has no Hermes', async () => {
    expect(await new HermesDetector().detect(FakeMachine.from({}), NOW)).toBeNull();
  });
});

describe('the OpenClaw detector', () => {
  it('takes the surfaces from its own tool list rather than assuming them', async () => {
    const machine = FakeMachine.from({
      '/home/dev/.openclaw/openclaw.json': `{
        // a comment, which JSON does not allow and OpenClaw writes anyway
        "tools": { "allow": ["read", "browser"], "deny": ["exec"] },
      }`,
    });

    const found = await new OpenClawDetector().detect(machine, NOW);
    const kinds = found?.surfaces.map((each) => each.kind).sort();

    // Denying exec genuinely removes the shell, and reporting one would overstate it.
    expect(kinds).toEqual(['browser', 'filesystem', 'network']);
  });

  it('grants nothing beyond the network when its config will not parse', async () => {
    const machine = FakeMachine.from({
      '/home/dev/.openclaw/openclaw.json': '{ this is not a config',
    });

    const found = await new OpenClawDetector().detect(machine, NOW);

    expect(found?.surfaces.map((each) => each.kind)).toEqual(['network']);
  });

  it('counts every agent directory as its own principal', async () => {
    const machine = FakeMachine.from({
      '/home/dev/.openclaw/openclaw.json': '{"agents":{"entries":{"restricted":{}}}}',
      '/home/dev/.openclaw/agents': '',
      '/home/dev/.openclaw/agents/support/agent/openclaw-agent.sqlite': '',
      '/home/dev/.openclaw/agents/deploy/agent/openclaw-agent.sqlite': '',
      '/home/dev/.openclaw/nodes': '',
    });

    const found = await new OpenClawDetector().detect(machine, NOW);

    expect(found?.hosted?.roles).toEqual(['deploy', 'restricted', 'support']);
    expect(found?.hosted?.federated).toBe(true);
  });
});

describe('the Ruflo detector', () => {
  const PROJECT = '/work/api';
  const machine = (): FakeMachine =>
    FakeMachine.from({
      // The primary config its own user guide names, and the optional swarm state.
      [`${PROJECT}/claude-flow.config.json`]: '{}',
      [`${PROJECT}/.claude-flow`]: '',
      [`${PROJECT}/.swarm`]: '',
      [`${PROJECT}/.claude`]: '',
      [`${PROJECT}/.claude/settings.json`]: '{}',
      [`${PROJECT}/.claude/agents/planner.md`]: 'plans',
      [`${PROJECT}/.claude/agents/coder.md`]: 'codes',
      [`${PROJECT}/.claude/agents/deployer.md`]: 'deploys',
      [`${PROJECT}/.claude-flow/federation`]: '',
      [`${PROJECT}/.mcp.json`]: JSON.stringify({
        mcpServers: { 'claude-flow': { command: 'npx', args: ['ruflo@latest', 'mcp'] } },
      }),
    });

  it('is found beside the work, not in the home directory', async () => {
    const found = await new RufloDetector().detect(machine(), NOW, {
      projectDirs: [PROJECT],
    });

    expect(found?.agent.kind).toBe('ruflo');
    expect(found?.agent.configPaths).toContain(`${PROJECT}/claude-flow.config.json`);
  });

  it('names the roles, the runtime it drives and the hooks it installed', async () => {
    const found = await new RufloDetector().detect(machine(), NOW, {
      projectDirs: [PROJECT],
    });

    expect(found?.hosted?.roles).toEqual(['coder', 'deployer', 'planner']);
    expect(found?.hosted?.runtimes).toEqual(['claude-code']);
    expect(found?.hosted?.hooks).toContain(`${PROJECT}/.claude/settings.json`);
    expect(found?.hosted?.federated).toBe(true);
  });

  it('reads the MCP server it registered for itself', async () => {
    const found = await new RufloDetector().detect(machine(), NOW, {
      projectDirs: [PROJECT],
    });
    const mcp = found?.surfaces.find((each) => each.kind === SURFACE_KIND.MCP);

    expect(mcp?.servers?.map((each) => each.name)).toEqual(['claude-flow']);
  });

  it('is absent when no project directory was given, rather than guessed at', async () => {
    expect(await new RufloDetector().detect(machine(), NOW)).toBeNull();
  });
});

describe('a host filter', () => {
  /* Verified against Hermes' own source: a present include decides alone, exclude is
     not consulted, and an explicit empty include registers nothing. */
  it("follows Hermes' rules when the filter came from Hermes", () => {
    const both = {
      include: ['list_*', 'create_issue'],
      exclude: ['create_issue'],
      precedence: FILTER_PRECEDENCE.INCLUDE_WINS,
    };

    expect(passesFilter('list_issues', both)).toBe(true);
    // On the include list and on the exclude list: include wins, so it is reachable.
    expect(passesFilter('create_issue', both)).toBe(true);
    expect(passesFilter('merge_pull_request', both)).toBe(false);

    const nothing = {
      include: [],
      exclude: [],
      precedence: FILTER_PRECEDENCE.INCLUDE_WINS,
    };
    expect(passesFilter('anything', nothing)).toBe(false);

    const blacklist = {
      exclude: ['delete_*'],
      precedence: FILTER_PRECEDENCE.INCLUDE_WINS,
    };
    expect(passesFilter('delete_repo', blacklist)).toBe(false);
    expect(passesFilter('list_issues', blacklist)).toBe(true);
  });

  it("follows OpenClaw's rules when the filter came from OpenClaw", () => {
    const filter = {
      include: ['read', 'write'],
      exclude: ['write'],
      precedence: FILTER_PRECEDENCE.EXCLUDE_WINS,
    };

    expect(passesFilter('read', filter)).toBe(true);
    // Denied and allowed: here deny is checked first, which is the opposite of Hermes.
    expect(passesFilter('write', filter)).toBe(false);
    expect(passesFilter('exec', filter)).toBe(false);
  });

  /* Tool names are identifiers, not prose: `readFile` and `readfile` are two tools,
     and the policy matcher's case-insensitive globs would conflate them. */
  it('matches a tool name case-sensitively', () => {
    const filter = {
      include: ['read*'],
      exclude: [],
      precedence: FILTER_PRECEDENCE.INCLUDE_WINS,
    };

    expect(passesFilter('readFile', filter)).toBe(true);
    expect(passesFilter('ReadFile', filter)).toBe(false);
  });

  it('lets everything through when there is no filter at all', () => {
    expect(passesFilter('anything', undefined)).toBe(true);
  });
});

describe('the roster', () => {
  it('lists a harness as a harness, with the principals under it', async () => {
    const report = await discover(
      FakeMachine.from({
        '/home/dev/.hermes/config.yaml': HERMES_CONFIG,
        '/home/dev/.claude.json': '{"mcpServers":{}}',
        '/work/api/.claude-flow': '',
        '/work/api/.claude/agents/coder.md': 'codes',
      }),
      { now: NOW, projectDirs: ['/work/api'] },
    );

    expect(report.agents.map((each) => each.kind).sort()).toEqual([
      'claude-code',
      'hermes',
      'ruflo',
    ]);
    expect(report.harnesses.map((each) => each.kind).sort()).toEqual(['hermes', 'ruflo']);
    // Claude Code is not a harness, so it never appears in that list.
    expect(report.harnesses.some((each) => each.kind === 'claude-code')).toBe(false);
  });
});

describe('drift under a harness', () => {
  const scan = async (files: Record<string, string>) =>
    snapshotOf(
      await discover(FakeMachine.from(files), { now: NOW, projectDirs: ['/work/api'] }),
      NOW,
    );

  const BASE = {
    '/work/api/.claude-flow': '',
    '/work/api/.claude/agents/planner.md': 'plans',
  };

  it('reports a role that appeared overnight, which no client config would show', async () => {
    const before = await scan(BASE);
    const after = await scan({
      ...BASE,
      '/work/api/.claude/agents/deployer.md': 'deploys',
    });

    const changes = compareSnapshots(before, after);
    const harness = changes.filter((each) => each.subject === 'harness');

    expect(harness).toHaveLength(1);
    expect(harness[0]?.detail).toBe('1 new role: deployer');
    expect(harness[0]?.direction).toBe('widens');
    // And it is worth interrupting somebody for: a role is a principal.
    expect(alertsFor(changes).map((each) => each.kind)).toContain('harness-widened');
  });

  it('reports federation being switched on, and says what it cannot see', async () => {
    const before = await scan(BASE);
    const after = await scan({ ...BASE, '/work/api/.claude-flow/federation': '' });

    const [change] = compareSnapshots(before, after).filter(
      (each) => each.subject === 'harness',
    );

    expect(change?.detail).toContain('this scan cannot see');
  });

  it('says nothing when nothing under the harness moved', async () => {
    const before = await scan(BASE);
    const after = await scan(BASE);

    expect(compareSnapshots(before, after)).toEqual([]);
  });
});

describe('what the Ruflo detector refuses to key on', () => {
  /* `.harness/` is Harness.io's CI directory. Keying on it would have reported a
     swarm on every repository that uses a completely different product. */
  it('is not fooled by another product that owns a similar directory', async () => {
    const machine = FakeMachine.from({
      '/work/api/.harness/pipeline.yaml': 'kind: Pipeline',
      '/work/api/.claude-plugin/plugin.json': '{}',
    });

    expect(
      await new RufloDetector().detect(machine, NOW, { projectDirs: ['/work/api'] }),
    ).toBeNull();
  });

  it('does not call a plain Claude Code checkout a swarm', async () => {
    const machine = FakeMachine.from({ '/work/api/.claude/settings.json': '{}' });

    expect(
      await new RufloDetector().detect(machine, NOW, { projectDirs: ['/work/api'] }),
    ).toBeNull();
  });

  it('names Codex as a runtime when the swarm was scaffolded for it', async () => {
    const machine = FakeMachine.from({
      '/work/api/claude-flow.config.json': '{}',
      '/work/api/AGENTS.md': 'codex spec',
      '/work/api/.agents/planner.md': 'plans',
    });

    const found = await new RufloDetector().detect(machine, NOW, {
      projectDirs: ['/work/api'],
    });

    expect(found?.hosted?.runtimes).toEqual(['codex-cli']);
    expect(found?.hosted?.roles).toEqual(['planner']);
  });
});
