import {
  distinctTools,
  TOOL_EFFECT,
  type DiscoveryReport,
  type McpTool,
  type ToolEffect,
} from '@memnox/core';
import type { CliContext } from '../cli-context';
import { describeCount } from '../plural';

/** Order matters: what can destroy is read before what can only read. */
const EFFECT_ORDER: readonly { effect: ToolEffect; label: string }[] = [
  { effect: TOOL_EFFECT.DESTRUCTIVE, label: 'destructive' },
  { effect: TOOL_EFFECT.WRITE, label: 'write' },
  { effect: TOOL_EFFECT.UNKNOWN, label: 'unknown' },
  { effect: TOOL_EFFECT.READ, label: 'read' },
];

/** How many of the listed tools change something outside, and how many nobody could class. */
interface ToolTally {
  external: number;
  unknown: number;
  total: number;
}

/**
 * "Thirty one tools" becomes "eight of them change external state", which is the only
 * version of that sentence anybody can act on.
 */
export function renderTools(context: CliContext, report: DiscoveryReport): void {
  const { flow, style } = context;
  const servers = toolsByServer(report);
  if (servers.size === 0) {
    // Honest when empty: without a probe the servers are named and hold no tools.
    flow.close('No MCP tools found.');
    flow.hint('Run without --no-probe to ask each server what it holds.');
    return;
  }

  const credentials = credentialsByServer(report);
  const tally: ToolTally = { external: 0, unknown: 0, total: 0 };
  for (const [server, tools] of [...servers].sort()) {
    const counted = renderServerTools(context, server, tools);
    tally.external += counted.external;
    tally.unknown += counted.unknown;
    tally.total += counted.total;
    // Under the block rather than in its title, so a long list never pushes the name off.
    const handed = credentials.get(server) ?? [];
    if (handed.length > 0) flow.aside(style.warn(`handed ${handed.join(', ')}`));
  }

  flow.close(
    tally.external === 0
      ? 'Nothing here is known to change external state.'
      : style.warn(`${tally.external} of ${tally.total} change external state.`),
  );
  if (tally.unknown > 0) {
    flow.hint(
      `${tally.unknown} could not be classified, so they are counted as neither.`,
    );
  }
}

/** Distinct first, or a server declared in five editors lists every tool five times. */
function toolsByServer(report: DiscoveryReport): Map<string, McpTool[]> {
  const servers = new Map<string, McpTool[]>();
  for (const tool of distinctTools(report.surfaces)) {
    servers.set(tool.server, [...(servers.get(tool.server) ?? []), tool]);
  }
  return servers;
}

/** One server's table, counted so the closing line can add every server up. */
function renderServerTools(
  context: CliContext,
  server: string,
  tools: readonly McpTool[],
): ToolTally {
  const { style } = context;
  const tally: ToolTally = { external: 0, unknown: 0, total: tools.length };
  const rows: string[][] = [];
  for (const { effect, label } of EFFECT_ORDER) {
    const matching = tools.filter((tool) => tool.effect === effect);
    // Unknown is not counted as external: an inferred blank is not evidence of harm.
    if (effect === TOOL_EFFECT.UNKNOWN) tally.unknown += matching.length;
    else if (effect !== TOOL_EFFECT.READ) tally.external += matching.length;
    for (const tool of [...matching].sort((a, b) => a.name.localeCompare(b.name))) {
      rows.push([
        effect === TOOL_EFFECT.READ ? style.dim(label) : style.warn(label),
        tool.name,
        // How it was decided rides along, so a wrong call is arguable rather than final.
        style.dim(tool.inferredFrom),
      ]);
    }
  }
  context.flow.table(
    `${server}, ${describeCount(tools.length, 'tool')}`,
    ['Effect', 'Tool', 'Read from'],
    rows,
  );
  return tally;
}

/** What each server's config hands it, by variable name only: the value stays in its file. */
function credentialsByServer(report: DiscoveryReport): Map<string, string[]> {
  const byServer = new Map<string, string[]>();
  for (const surface of report.surfaces) {
    for (const launch of surface.servers ?? []) {
      const env = launch.env;
      if (env === undefined || env.length === 0) continue;
      byServer.set(launch.name, [
        ...new Set([...(byServer.get(launch.name) ?? []), ...env]),
      ]);
    }
  }
  return byServer;
}
