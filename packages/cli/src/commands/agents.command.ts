/** `memnox agents`: registers each subcommand and hands it to its `run*` function. */
import { homedir } from 'node:os';
import type { Command } from 'commander';
import { PROBATION_KIND } from '@memnox/core';
import type { CliContext } from '../cli-context';
import { defaultScanSeams } from '../machine-scan';
import { askOnTerminal } from '../agents/name-prompt';
import { runTrust } from '../probation-view';
import { collect, type AgentsDeps, type JsonOptions } from './agents/shared';
import { runDiscover, type DiscoverOptions } from './agents/discover';
import { runList } from './agents/list';
import { runName, type NameOptions } from './agents/name';
import { runStatus } from './agents/status';
import { runOffboard, runOnboard, type OnboardOptions } from './agents/onboard';
import { runControl } from './agents/control';

/** Everything but the context, for a test to swap; each has a real default. */
type AgentsSeams = Omit<AgentsDeps, 'context'>;

/**
 * The agents on this machine: find them, name them, put them to work. Local rather than
 * fleet-wide, because a machine credential must not answer fleet questions; `control` is
 * the one subcommand that talks to the control plane.
 */
export function registerAgentsCommand(
  program: Command,
  context: CliContext,
  overrides: Partial<AgentsSeams> = {},
): void {
  const deps: AgentsDeps = {
    context,
    home: homedir,
    seams: () => defaultScanSeams(),
    ask: askOnTerminal,
    interactive: () => process.stdin.isTTY === true,
    project: () => process.cwd(),
    ...overrides,
  };
  const agents = program
    .command('agents')
    .description('The agents on this machine: find them, name them, put them to work');
  registerLocalSubcommands(agents, deps);
  registerWorkspaceSubcommands(agents, deps);
  registerTrustSubcommand(agents, deps);
}

/** Ends the probation an agent the daemon adopted started on. */
function registerTrustSubcommand(agents: Command, deps: AgentsDeps): void {
  agents
    .command('trust <agent>')
    .description("End an agent's probation now, so only your rules decide what it does")
    .action(async (agent: string) =>
      runTrust({
        context: deps.context,
        home: deps.home(),
        kind: PROBATION_KIND.AGENT,
        name: agent,
        now: new Date(),
      }),
    );
}

/** The subcommands that read and name what this machine hosts. */
function registerLocalSubcommands(agents: Command, deps: AgentsDeps): void {
  agents
    .command('discover', { isDefault: true })
    .description('Scan this machine for agents, and name what it found')
    .option('--json', 'machine-readable output')
    .option('--no-ask', 'do not ask what to call them')
    .option(
      '--name <agent=name>',
      'name one without being asked, repeatable',
      collect,
      [] as string[],
    )
    .option('--no-probe', 'do not start any MCP server to ask what it offers')
    .action(async (options: DiscoverOptions) => runDiscover(deps, options));

  agents
    .command('list')
    .description('What this machine hosts, from the last scan')
    .option('--json', 'machine-readable output')
    .action(async (options: JsonOptions) => runList(deps, options));

  agents
    .command('name <agent> [name]')
    .description('Call an agent whatever you call it, and see that name everywhere')
    .option('--clear', 'go back to the name the detector gave it')
    .option('--json', 'machine-readable output')
    .action(async (agent: string, wanted: string | undefined, options: NameOptions) =>
      runName(deps, agent, wanted, options),
    );

  agents
    .command('status <agent>')
    .description('What is known about one agent on this machine')
    .option('--json', 'machine-readable output')
    .action(async (agent: string, options: JsonOptions) =>
      runStatus(deps, agent, options),
    );
}

/** The subcommands that put an agent under the workspace, take it out, or hear from it. */
function registerWorkspaceSubcommands(agents: Command, deps: AgentsDeps): void {
  agents
    .command('onboard [agent]')
    .description('Put an agent under Memnox, backing up its config first')
    .option('--name <name>', 'what the workspace should call it, rather than being asked')
    .option('--json', 'machine-readable output')
    .action(async (agent: string | undefined, options: OnboardOptions) =>
      runOnboard(deps, agent, options),
    );

  agents
    .command('offboard <agent>')
    .description("Put an agent's config back and take its credential away")
    .option('--json', 'machine-readable output')
    .action(async (agent: string, options: JsonOptions) =>
      runOffboard(deps, agent, options),
    );

  agents
    .command('control [agent]')
    .description('Collect what an operator has said to the agents on this machine')
    .option('--json', 'machine-readable output')
    .action(async (agent: string | undefined, options: JsonOptions) =>
      runControl(deps, agent, options),
    );
}
