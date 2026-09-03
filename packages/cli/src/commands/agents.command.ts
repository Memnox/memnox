import type { Command } from 'commander';
import type { CliContext } from '../cli-context';
import { AGENT_KIND, AGENT_STATUS } from '@memnox/core';
import { DEFAULT_BASE_URL } from '../defaults';
import { defaultScanSeams, scanMachine, type ScanSeams } from '../machine-scan';

export function registerAgentsCommand(
  program: Command,
  context: CliContext,
  buildSeams: (cwd: string) => ScanSeams = defaultScanSeams,
  cwd: () => string = () => process.cwd(),
): void {
  const agents = program.command('agents').description('Manage agent identities');

  agents
    .command('register')
    .description('Register a new agent and print its token (shown once)')
    .requiredOption('--name <name>', 'agent name, e.g. claude-code')
    .requiredOption('--role <role>', 'the job it does, e.g. release-engineer')
    .requiredOption('--principal <person>', 'the person it acts for')
    .option(
      '--kind <kind>',
      `the product (${Object.values(AGENT_KIND).join('|')})`,
      AGENT_KIND.CUSTOM,
    )
    .option('--url <url>', `runtime base URL (default: ${DEFAULT_BASE_URL})`)
    .option('--admin-token <token>', 'admin token if the runtime requires one')
    .action(
      async (options: {
        name: string;
        kind: string;
        role: string;
        principal: string;
        url?: string;
        adminToken?: string;
      }) => {
        const { client } = await context.connect(options);
        const registration = await client.registerAgent({
          name: options.name,
          kind: options.kind,
          role: options.role,
          principal: options.principal,
        });
        const { agent } = registration;
        context.out.line(`Agent registered: ${agent.name} (${agent.id})`);
        // The three fields, echoed back: policy is written about the role.
        context.out.line(
          `  ${agent.kind} · ${options.role} · acting for ${options.principal}`,
        );
        context.out.line(`Token (store it now — it is never shown again):`);
        context.out.line(registration.token);
      },
    );

  agents
    .command('list')
    .description('List agents with the level each was granted')
    .option('--url <url>', `runtime base URL (default: ${DEFAULT_BASE_URL})`)
    .option('--admin-token <token>', 'admin token if the runtime requires one')
    .action(async (options: { url?: string; adminToken?: string }) => {
      const { client } = await context.connect(options);
      const list = await client.listAgents();
      if (list.length === 0) {
        context.out.line('No agents registered.');
        return;
      }
      for (const agent of list) {
        context.out.line(
          `${agent.id}  ${agent.name} (${agent.kind}) [${agent.status}] level ${agent.autonomyLevel ?? 'not granted'} — allowed ${agent.stats.allowed}, withheld ${agent.stats.withheld}`,
        );
      }
    });

  agents
    .command('unregistered')
    .description('Agents running on this machine that nobody enrolled')
    .option('--url <url>', `runtime base URL (default: ${DEFAULT_BASE_URL})`)
    .option('--admin-token <token>', 'admin token if the runtime requires one')
    .option(
      '--no-probe',
      'do not start MCP servers to ask what they hold; tools go uncounted',
    )
    .action(async (options: { url?: string; adminToken?: string; probe: boolean }) => {
      const { client } = await context.connect(options);
      const enrolled = await client.listAgents();
      const seams = buildSeams(cwd());
      const { report } = await scanMachine(seams, { probe: options.probe });

      /* An agent nobody enrolled is a row with evidence, not an absence: it is on this
         disk, it can act, and no rule was ever written about it. */
      const known = new Set(enrolled.map((agent) => agent.kind));
      const strangers = report.agents.filter((agent) => !known.has(agent.kind));

      const { out, style } = context;
      if (strangers.length === 0) {
        out.line('Every agent on this machine is enrolled.');
        return;
      }

      out.line('');
      out.line(style.warn(style.bold('UNREGISTERED')));
      out.line('');
      for (const agent of strangers) {
        const surfaces = report.surfaces
          .filter((surface) => surface.agentId === agent.id)
          .map((surface) => surface.kind);
        out.line(`  ${style.bold(agent.kind)}`);
        out.line(`    seen in    ${style.dim(agent.configPaths.join(', '))}`);
        out.line(`    since      ${style.dim(agent.firstSeen)}`);
        if (surfaces.length > 0) {
          out.line(`    reaches    ${[...new Set(surfaces)].sort().join(' · ')}`);
        }
        out.line(`    owner      ${style.warn('unclaimed')}`);
        out.line('');
      }
      out.line(
        style.dim(
          `${strangers.length} agent(s) here act through no identity this runtime issued. ` +
            'This machine only.',
        ),
      );
      out.line('');
    });

  agents
    .command('suspend <id>')
    .description('Suspend an agent — every action it attempts is withheld')
    .option('--url <url>', `runtime base URL (default: ${DEFAULT_BASE_URL})`)
    .option('--admin-token <token>', 'admin token if the runtime requires one')
    .action(async (id: string, options: { url?: string; adminToken?: string }) => {
      const { client } = await context.connect(options);
      const agent = await client.setAgentStatus(id, AGENT_STATUS.SUSPENDED);
      context.out.line(`Agent ${agent.name} is now ${agent.status}.`);
    });

  agents
    .command('activate <id>')
    .description('Re-activate a suspended agent')
    .option('--url <url>', `runtime base URL (default: ${DEFAULT_BASE_URL})`)
    .option('--admin-token <token>', 'admin token if the runtime requires one')
    .action(async (id: string, options: { url?: string; adminToken?: string }) => {
      const { client } = await context.connect(options);
      const agent = await client.setAgentStatus(id, AGENT_STATUS.ACTIVE);
      context.out.line(`Agent ${agent.name} is now ${agent.status}.`);
    });

  agents
    .command('assign <id>')
    .description('Name the person who answers for an agent')
    .requiredOption('--owner <person>', 'who answers for it')
    .option('--url <url>', `runtime base URL (default: ${DEFAULT_BASE_URL})`)
    .option('--admin-token <token>', 'admin token if the runtime requires one')
    .action(
      async (
        id: string,
        options: { owner: string; url?: string; adminToken?: string },
      ) => {
        const { client } = await context.connect(options);
        const agent = await client.setAgentOwner(id, options.owner);
        context.out.line(`${agent.name} is now answered for by ${options.owner}.`);
      },
    );

  agents
    .command('rotate <id>')
    .description('Issue a new token for an agent and retire the old one')
    .option('--url <url>', `runtime base URL (default: ${DEFAULT_BASE_URL})`)
    .option('--admin-token <token>', 'admin token if the runtime requires one')
    .action(async (id: string, options: { url?: string; adminToken?: string }) => {
      const { client } = await context.connect(options);
      const rotated = await client.rotateAgent(id);
      context.out.line(
        `Rotated ${rotated.agent.name}. The previous token no longer works.`,
      );
      context.out.line(`New token (shown once): ${rotated.token}`);
    });
}
