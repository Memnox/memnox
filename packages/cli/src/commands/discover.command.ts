import { homedir } from 'node:os';
import type { Command } from 'commander';
import {
  discover,
  NodeMachineReader,
  SENSITIVITY,
  SURFACE_KIND,
  type DiscoveryReport,
  type MachineReader,
} from '@memnox/discovery';
import type { CliContext } from '../cli-context';

/** Injected so a test never reads the developer's real home directory. */
export type MachineReaderFactory = () => MachineReader;

const PATH_WIDTH = 24;

/**
 * Runs with no account, no key and no network. Nothing is transmitted, which is the
 * only reason a security engineer runs this on a laptop holding production credentials.
 */
export function registerDiscoverCommand(
  program: Command,
  context: CliContext,
  buildReader: MachineReaderFactory = () => new NodeMachineReader(homedir()),
): void {
  program
    .command('discover', { isDefault: true })
    .description(
      'What can act on this machine, and what it can reach. No account, no network.',
    )
    .option('--json', 'emit the report as JSON')
    .action(async (options: { json?: boolean }) => {
      const report = await discover(buildReader(), { now: new Date().toISOString() });
      if (options.json === true) {
        context.out.line(JSON.stringify(report, null, 2));
        return;
      }
      render(context, report);
    });
}

function render(context: CliContext, report: DiscoveryReport): void {
  const { out, style } = context;

  if (report.agents.length === 0) {
    // With no fixtures there is no pretty default, so an empty machine reads as an answer.
    out.line('No AI agents found on this machine.');
    out.line(style.dim('Nothing was transmitted. Install an agent and run this again.'));
    return;
  }

  out.line(
    style.bold('AI AGENTS'.padEnd(PATH_WIDTH)) +
      report.agents.map((agent) => agent.kind).join(', '),
  );

  const servers = report.surfaces.filter((surface) => surface.kind === SURFACE_KIND.MCP);
  if (servers.length > 0) {
    const tools = servers.reduce(
      (total, surface) => total + (surface.tools ?? []).length,
      0,
    );
    out.line(
      style.bold('MCP CLIENTS'.padEnd(PATH_WIDTH)) +
        servers.map((surface) => surface.agentId.replace('agt_', '')).join(', ') +
        (tools === 0 ? '' : style.dim(`  ${tools} tools`)),
    );
  }

  const reachable = report.resources.filter(
    (resource) =>
      resource.sensitivity !== SENSITIVITY.ORDINARY && resource.reachableBy.length > 0,
  );
  if (reachable.length > 0) {
    out.line('');
    out.line(style.bold('REACHABLE FROM AN AGENT RIGHT NOW'));
    out.line('');
    for (const resource of reachable) {
      const agents = `${resource.reachableBy.length} agent${resource.reachableBy.length === 1 ? '' : 's'}`;
      out.line(
        `  ${style.warn('!')}  ${(resource.path ?? resource.id).padEnd(PATH_WIDTH)}${agents}`,
      );
    }
  }

  const surfaces = report.surfaces.filter((surface) => surface.kind !== SURFACE_KIND.MCP);
  out.line('');
  out.line(`${surfaces.length} execution surfaces.`);
  out.line('');
  out.line(`  ${style.dim('memnox doctor')}   what is risky and why`);
  out.line(`  ${style.dim('memnox harden')}   fix it, reversibly`);
}
