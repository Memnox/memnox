import {
  distinctTools,
  TOOL_EFFECT,
  type DiscoveryReport,
  type McpTool,
  type ToolEffect,
} from '@memnox/core';
import type { CliContext } from '../cli-context';

/** Order matters: what can destroy is read before what can only read. */
const EFFECT_ORDER: readonly { effect: ToolEffect; label: string; mark: string }[] = [
  { effect: TOOL_EFFECT.DESTRUCTIVE, label: 'DESTRUCTIVE', mark: '✕' },
  { effect: TOOL_EFFECT.WRITE, label: 'WRITE', mark: '⚠' },
  { effect: TOOL_EFFECT.UNKNOWN, label: 'UNKNOWN', mark: '?' },
  { effect: TOOL_EFFECT.READ, label: 'READ', mark: '✓' },
];

const EFFECT_COLUMN = 34;

/**
 * "Thirty one tools" becomes "eight of them change external state", which is the only
 * version of that sentence anybody can act on. Nobody wants to read thirty
 * descriptions, and no client anywhere shows which of them change something.
 */
export function renderTools(context: CliContext, report: DiscoveryReport): void {
  const { out, style } = context;
  // Distinct first, or a server declared in five editors lists every tool five times.
  const servers = new Map<string, McpTool[]>();
  for (const tool of distinctTools(report.surfaces)) {
    servers.set(tool.server, [...(servers.get(tool.server) ?? []), tool]);
  }
  const credentials = credentialsByServer(report);

  if (servers.size === 0) {
    // Honest when empty: without a probe the servers are named and hold no tools.
    out.line('No MCP tools found.');
    out.line(style.dim('Run without --no-probe to ask each server what it holds.'));
    return;
  }

  let external = 0;
  let unknown = 0;
  let total = 0;
  for (const [server, tools] of [...servers].sort()) {
    out.line('');
    out.line(
      style.bold(`${server}  «mcp»`.padEnd(EFFECT_COLUMN)) +
        `${tools.length} tool${tools.length === 1 ? '' : 's'}`,
    );
    total += tools.length;

    // What the config hands it, before anything asks whether it should have it. Names
    // only: the value stays in the file it was written in.
    const handed = credentials.get(server) ?? [];
    if (handed.length > 0) {
      out.line(`${'credentials'.padEnd(EFFECT_COLUMN)}${style.warn(handed.join(', '))}`);
    }

    for (const { effect, label, mark } of EFFECT_ORDER) {
      const matching = tools.filter((tool) => tool.effect === effect);
      if (matching.length === 0) continue;
      // Unknown is not counted as external: an inferred blank is not evidence of harm.
      if (effect === TOOL_EFFECT.UNKNOWN) unknown += matching.length;
      else if (effect !== TOOL_EFFECT.READ) external += matching.length;
      out.line('');
      out.line(style.bold(label.padEnd(EFFECT_COLUMN)) + String(matching.length));
      for (const tool of matching.sort((a, b) => a.name.localeCompare(b.name))) {
        const painted = effect === TOOL_EFFECT.READ ? mark : style.warn(mark);
        // How it was decided rides along, so a wrong call is arguable rather than final.
        out.line(
          `  ${painted}  ${tool.name.padEnd(EFFECT_COLUMN - 5)}${style.dim(tool.inferredFrom)}`,
        );
      }
    }
  }

  out.line('');
  out.line(
    external === 0
      ? 'Nothing here is known to change external state.'
      : style.warn(`→ ${external} of ${total} change external state`),
  );
  if (unknown > 0) {
    out.line(
      style.dim(`  ${unknown} could not be classified, so they are counted as neither`),
    );
  }
}

/**
 * A server is installed by pasting a line, and nothing between the paste and the first
 * tool call asks what it wants. This is what it asked for, read off the config.
 */
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
