import type { Command } from 'commander';
import type { CliContext } from '../cli-context';
import { AGENT_KIND, AGENT_STATUS } from '@memnox/core';
import { DEFAULT_BASE_URL } from '../defaults';

export function registerAgentsCommand(program: Command, context: CliContext): void {
  const agents = program.command('agents').description('Manage agent identities');

  agents
    .command('register')
    .description('Register a new agent and print its token (shown once)')
    .requiredOption('--name <name>', 'agent name, e.g. claude-code')
    .option(
      '--kind <kind>',
      `agent kind (${Object.values(AGENT_KIND).join('|')})`,
      AGENT_KIND.CUSTOM,
    )
    .option('--url <url>', `runtime base URL (default: ${DEFAULT_BASE_URL})`)
    .option('--admin-token <token>', 'admin token if the runtime requires one')
    .action(
      async (options: {
        name: string;
        kind: string;
        url?: string;
        adminToken?: string;
      }) => {
        const { client } = await context.connect(options);
        const registration = await client.registerAgent(options.name, options.kind);
        context.out.line(
          `Agent registered: ${registration.agent.name} (${registration.agent.id})`,
        );
        context.out.line(`Token (store it now — it is never shown again):`);
        context.out.line(registration.token);
      },
    );

  agents
    .command('list')
    .description('List agents with trust scores')
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
          `${agent.id}  ${agent.name} (${agent.kind}) [${agent.status}] trust ${agent.trustScore}/100 — allowed ${agent.stats.allowed}, withheld ${agent.stats.withheld}`,
        );
      }
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
