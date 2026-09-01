import { homedir } from 'node:os';
import type { Command } from 'commander';
import {
  discover,
  NodeMachineReader,
  NodeMcpLister,
  SENSITIVITY,
  SURFACE_KIND,
  TOOL_EFFECT,
  type DiscoveryReport,
  type MachineReader,
  type McpLister,
} from '@memnox/discovery';
import type { CliContext } from '../cli-context';
import { readLocalCounts, type LocalCounts } from '../local-counts';

/** Injected so a test never reads the developer's real home directory. */
export type MachineReaderFactory = () => MachineReader;

const LABEL_WIDTH = 24;
/** Padding is computed from the longest path, so a long one never eats its own count. */
const PATH_GUTTER = 2;

/**
 * Runs with no account, no key and no network. Nothing is transmitted, which is the
 * only reason a security engineer runs this on a laptop holding production credentials.
 */
export function registerDiscoverCommand(
  program: Command,
  context: CliContext,
  buildReader: MachineReaderFactory = () => new NodeMachineReader(homedir()),
  buildLister: () => McpLister = () => new NodeMcpLister(),
  cwd: () => string = () => process.cwd(),
  counts: () => Promise<LocalCounts> = () => readLocalCounts(homedir()),
): void {
  program
    .command('discover', { isDefault: true })
    /* Bare `memnox` runs this, but `memnox audti` must not: with a default command
       commander hands an unknown word here as an argument, and a typo would silently
       scan the machine and exit 0 instead of saying the command does not exist. */
    .allowExcessArguments(false)
    .description(
      'What can act on this machine, and what it can reach. No account, no network.',
    )
    .option('--json', 'emit the report as JSON')
    .option(
      '--no-probe',
      'do not start MCP servers to ask what they hold; tools go uncounted',
    )
    .action(async (options: { json?: boolean; probe: boolean }) => {
      const report = await discover(buildReader(), {
        now: new Date().toISOString(),
        // The directory they are standing in holds the credentials the repo has.
        projectDirs: [cwd()],
        // Starting somebody else's server is the one thing here that runs code.
        ...(options.probe ? { lister: buildLister() } : {}),
      });
      if (options.json === true) {
        context.out.line(JSON.stringify(report, null, 2));
        return;
      }
      render(context, report, await counts());
    });
}

function render(context: CliContext, report: DiscoveryReport, counts: LocalCounts): void {
  const { out, style } = context;

  if (report.agents.length === 0) {
    // With no fixtures there is no pretty default, so an empty machine reads as an answer.
    out.line('No AI agents found on this machine.');
    out.line(style.dim('Nothing was transmitted. Install an agent and run this again.'));
    return;
  }

  out.line(
    style.bold('AI AGENTS'.padEnd(LABEL_WIDTH)) +
      report.agents.map((agent) => agent.kind).join(', '),
  );

  const servers = report.surfaces.filter((surface) => surface.kind === SURFACE_KIND.MCP);
  if (servers.length > 0) {
    const tools = servers.reduce(
      (total, surface) => total + (surface.tools ?? []).length,
      0,
    );
    out.line(
      style.bold('MCP CLIENTS'.padEnd(LABEL_WIDTH)) +
        servers.map((surface) => surface.agentId.replace('agt_', '')).join(', ') +
        (tools === 0 ? '' : style.dim(`  ${tools} tools`)),
    );

    const named = [
      ...new Set(
        servers.flatMap((surface) => (surface.servers ?? []).map((each) => each.name)),
      ),
    ];
    if (named.length > 0) {
      out.line(style.bold('MCP SERVERS'.padEnd(LABEL_WIDTH)) + named.join(', '));
    }

    // The line that lands: a count of destructive tools nothing is checking.
    const destructive = servers
      .flatMap((surface) => surface.tools ?? [])
      .filter((tool) => tool.effect === TOOL_EFFECT.DESTRUCTIVE);
    if (destructive.length > 0) {
      out.line(
        ''.padEnd(LABEL_WIDTH) +
          style.warn(
            `${destructive.length} of them destructive, and nothing is checking any of them`,
          ),
      );
    }
  }

  // Everything an agent with a shell reaches through one of these, whether or not
  // Memnox can see the call.
  if (report.tools.length > 0) {
    out.line(
      style.bold('TOOLS'.padEnd(LABEL_WIDTH)) +
        report.tools.map((tool) => tool.name).join(', '),
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
    const paths = reachable.map((resource) => resource.path ?? resource.id);
    const width =
      Math.max(LABEL_WIDTH, ...paths.map((path) => path.length)) + PATH_GUTTER;
    reachable.forEach((resource, index) => {
      const count = resource.reachableBy.length;
      const agents = `${count} agent${count === 1 ? '' : 's'}`;
      out.line(`  ${style.warn('!')}  ${(paths[index] ?? '').padEnd(width)}${agents}`);
      // A database or the network is not a file, so what named it is said plainly.
      if (resource.declaredIn !== undefined) {
        out.line(`     ${style.dim(resource.declaredIn)}`);
      }
    });
  }

  const surfaces = report.surfaces.filter((surface) => surface.kind !== SURFACE_KIND.MCP);
  out.line('');
  out.line(`${surfaces.length} execution surfaces.`);
  // Both are zero on a machine nobody has governed, which is the honest opening.
  out.line(
    `${counts.policies} ${counts.policies === 1 ? 'policy' : 'policies'}.  ${counts.records} record${counts.records === 1 ? '' : 's'}.`,
  );
  out.line('');
  out.line(`  ${style.dim('memnox doctor')}   what is risky and why`);
  out.line(`  ${style.dim('memnox harden')}   fix it, reversibly`);
}
