import { describe, expect, it } from 'vitest';
import { registerScanCommand } from '../src/commands/scan.command';
import { registerExplainCommand } from '../src/commands/explain.command';
import { runCommand } from './cli-harness';
import {
  fakeSeams,
  FakeMachine,
  HOME,
  MemorySnapshots,
  PROJECT,
  StubLister,
} from './machine-harness';

const HERMES = `mcp_servers:
  crm:
    command: npx
    args: ["crm-mcp"]
    tools:
      exclude: [delete_customer]
`;

const MACHINE = {
  [`${HOME}/.hermes/config.yaml`]: HERMES,
  [`${PROJECT}/.claude-flow`]: '',
  [`${PROJECT}/.claude`]: '',
  [`${PROJECT}/.claude/agents/planner.md`]: 'plans',
  [`${PROJECT}/.claude/agents/deployer.md`]: 'deploys',
};

/** What the crm server really holds, one of which Hermes' own config takes away. */
const CRM_TOOLS = [
  { name: 'read_customer' },
  { name: 'create_customer_export' },
  { name: 'send_customer_report' },
  { name: 'delete_customer' },
];

const snapshots = new MemorySnapshots();

const seams = (): ReturnType<typeof fakeSeams> =>
  fakeSeams(FakeMachine.from(MACHINE), {
    lister: () => new StubLister(CRM_TOOLS),
    projectDirs: [PROJECT],
    snapshots,
  });

describe('memnox scan, with a harness on the machine', () => {
  it('says a harness is a harness, and how many principals sit behind it', async () => {
    const { out } = await runCommand(
      (program, context) => registerScanCommand(program, context, seams),
      ['scan'],
    );

    expect(out.text).toContain('HARNESSES');
    expect(out.text).toContain('hermes');
    expect(out.text).toContain('ruflo');
    // Two roles under Ruflo plus Hermes' own row: the roster is not three agents.
    expect(out.text).toContain('3 principals');
    expect(out.text).toContain('2 roles');
  });

  it('credits the filter the host already applies rather than counting past it', async () => {
    const { out } = await runCommand(
      (program, context) => registerScanCommand(program, context, seams),
      ['scan'],
    );

    expect(out.text).toContain("hidden by the host's own filter");
    // The tool Hermes excluded is not reported as reachable through Hermes.
    expect(out.text).not.toContain('destructive, and nothing is checking');
  });

  it('names the path no single tool takes', async () => {
    const { out } = await runCommand(
      (program, context) => registerScanCommand(program, context, seams),
      ['scan'],
    );

    expect(out.text).toContain('COMBINED CAPABILITY');
    expect(out.text).toContain('customer data can leave, in one session');
    expect(out.text).toContain('crm.read_customer');
    expect(out.notes).toContain(
      'Each of these tools is ordinary. Holding all of them is the path.',
    );
  });

  it('carries the harness and the chain through --json', async () => {
    const { out } = await runCommand(
      (program, context) => registerScanCommand(program, context, seams),
      ['scan', '--json'],
    );
    const inventory = JSON.parse(out.text) as {
      version: number;
      harnesses: { kind: string; roles: string[] }[];
      chains: { subject: string; individuallyHarmless: boolean }[];
    };

    expect(inventory.version).toBe(2);
    expect(inventory.harnesses.map((each) => each.kind).sort()).toEqual([
      'hermes',
      'ruflo',
    ]);
    expect(inventory.chains[0]?.subject).toBe('customer');
    expect(inventory.chains[0]?.individuallyHarmless).toBe(true);
  });
});

describe('memnox explain <harness>', () => {
  it('answers with what it runs, not with what it is', async () => {
    const { out } = await runCommand(
      (program, context) => registerExplainCommand(program, context, seams),
      ['explain', 'ruflo'],
    );

    expect(out.text).toContain('harness, runs other agents');
    expect(out.text).toContain('claude-code');
    expect(out.text).toContain('deployer, planner');
    // Memnox governs underneath it; it does not claim to replace what it enforces.
    expect(out.notes.join('\n')).toContain('Memnox governs what it reaches underneath');
  });

  it('shows the chain a harness can complete, from the last saved scan', async () => {
    // Explain never starts an MCP server, so the tools have to come from a saved scan.
    await runCommand(
      (program, context) => registerScanCommand(program, context, seams),
      ['scan', '--save'],
    );

    const { out } = await runCommand(
      (program, context) => registerExplainCommand(program, context, seams),
      ['explain', 'hermes'],
    );

    expect(out.text).toContain('Combined capability');
    expect(out.text).toContain('crm.read_customer');
  });

  it('says so plainly when no scan here has asked the servers', async () => {
    const fresh = (): ReturnType<typeof fakeSeams> =>
      fakeSeams(FakeMachine.from(MACHINE), { projectDirs: [PROJECT] });

    const { out } = await runCommand(
      (program, context) => registerExplainCommand(program, context, fresh),
      ['explain', 'hermes'],
    );

    expect(out.notes.join('\n')).toContain('No scan here has asked the servers');
  });
});

describe('memnox explain <agent>', () => {
  it('answers for an ordinary agent, not only for a harness', async () => {
    const machine = FakeMachine.from({
      [`${HOME}/.cursor/mcp.json`]: JSON.stringify({
        mcpServers: { github: { command: 'npx', args: ['gh-mcp'] } },
      }),
    });
    const only = (): ReturnType<typeof fakeSeams> => fakeSeams(machine);

    const { out } = await runCommand(
      (program, context) => registerExplainCommand(program, context, only),
      ['explain', 'cursor'],
    );

    expect(out.text).toContain('cursor  · agent');
    expect(out.text).toContain('github');
    expect(out.text).toContain('holds one, which reaches everything you can');
    // Roles and hooks belong to a harness; printing them empty implies Cursor could have had them.
    expect(out.text).not.toContain('Roles');
    expect(out.text).not.toContain('Hooks');
    expect(out.notes.join('\n')).not.toContain('enforces its own tool policy');
  });
});

/**
 * Everything the scan names, explain answers about.
 *
 * The two screens are read one after the other: somebody sees a name on the scan and
 * types it. `explain` answered for agents and for authenticated CLIs only, so a scan
 * listing eight tools and one MCP server was followed by nine "nothing here provides
 * that" — which is the answer that makes a reader stop trusting both screens rather
 * than one. Asserted as a property, because the next name added to a scan should fail
 * here rather than in front of somebody.
 */
describe('what the scan names, explain can answer', () => {
  it('answers for every name the rendered scan puts on screen', async () => {
    await runCommand(
      (program, context) => registerScanCommand(program, context, seams),
      ['scan', '--save'],
    );

    const { out } = await runCommand(
      (program, context) => registerScanCommand(program, context, seams),
      ['scan'],
    );

    /* Read off the rendered scan rather than the JSON, because the rendered scan is
       what somebody is looking at when they decide what to type. */
    const named = new Set<string>();
    for (const line of out.text.split('\n')) {
      const row = /^(AI AGENTS|MCP SERVERS|TOOLS)\s{2,}(.+)$/.exec(line.trim());
      if (row === null) continue;
      for (const name of (row[2] ?? '').split(',')) {
        const cleaned = name.trim();
        if (cleaned !== '' && !cleaned.includes(' ')) named.add(cleaned);
      }
    }
    expect(named.size).toBeGreaterThan(2);

    for (const subject of named) {
      await expect(
        runCommand(
          (program, context) => registerExplainCommand(program, context, seams),
          ['explain', subject],
        ),
        `the scan names "${subject}" and explain cannot answer for it`,
      ).resolves.toBeDefined();
    }
  });

  it('says a server was not asked rather than that it holds nothing', async () => {
    const { out } = await runCommand(
      (program, context) => registerExplainCommand(program, context, seams),
      ['explain', 'crm'],
    );
    expect(out.text).toContain('MCP server');
    expect(out.text).toContain('Declared by');
  });
});
