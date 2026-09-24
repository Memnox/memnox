/** One MCP server the scan named: what it declares, and what it can reach. */

import type { DiscoveryReport, McpTool } from '@memnox/core';
import { TOOL_EFFECT } from '@memnox/core';

import type { CliContext } from '../../cli-context';

interface ExplainedServer {
  name: string;
  /** Agents whose config declares it. */
  agents: string[];
  /** The config files that proved it. */
  detectedFrom: string[];
  /** Credential names the config hands it. Names only, never a value. */
  env: string[];
  /** Tools from the last scan that actually asked. Absent is "not asked", not "none". */
  tools: McpTool[];
  probed: boolean;
}

/** What the scan knows about one server, gathered from every agent that declares it. */
export function serverNamed(
  report: DiscoveryReport,
  name: string,
): ExplainedServer | null {
  const agents = new Set<string>();
  const detectedFrom = new Set<string>();
  const env = new Set<string>();
  const tools: McpTool[] = [];
  let declared = false;

  for (const surface of report.surfaces) {
    for (const launch of surface.servers ?? []) {
      if (launch.name !== name) continue;
      declared = true;
      detectedFrom.add(surface.detectedFrom);
      for (const variable of launch.env ?? []) env.add(variable);
      const agent = report.agents.find((each) => each.id === surface.agentId);
      if (agent !== undefined) agents.add(agent.kind);
    }
    for (const tool of surface.tools ?? []) {
      if (tool.server === name) tools.push(tool);
    }
  }

  if (!declared) return null;
  return {
    name,
    agents: [...agents].sort(),
    detectedFrom: [...detectedFrom].sort(),
    env: [...env].sort(),
    tools,
    probed: tools.length > 0,
  };
}

export function renderServer(
  context: CliContext,
  server: ExplainedServer,
  asJson: boolean,
): void {
  if (asJson) {
    context.out.json(server);
    return;
  }

  const { flow } = context;
  flow.rows(`${server.name}, an MCP server`, [
    {
      label: 'declared by',
      value: server.agents.length === 0 ? 'no agent here' : server.agents.join(', '),
    },
    ...server.detectedFrom.map((path) => ({ label: 'from', value: path })),
    // Names only: what a config hands a server, never the value behind it.
    ...(server.env.length === 0
      ? []
      : [{ label: 'credentials', value: server.env.join(', ') }]),
  ]);

  if (!server.probed) {
    // Not asked yet is a different claim from holds nothing, and explain never starts a server.
    flow.close('No tools recorded, because nothing has asked this server what it holds.');
    flow.hint('"memnox scan" starts it and asks; this command never does.');
    return;
  }
  renderTools(context, server);
}

function renderTools(context: CliContext, server: ExplainedServer): void {
  const { flow, style } = context;
  flow.table(
    'Holds',
    ['Tool', 'Effect'],
    server.tools.map((tool) => [
      tool.name,
      tool.effect === TOOL_EFFECT.DESTRUCTIVE
        ? style.warn(tool.effect)
        : style.dim(tool.effect),
    ]),
  );
  flow.close(`${server.tools.length} tool(s) on ${server.name}.`);
  flow.hint(
    `memnox protect --for ${server.name}   put the dangerous ones behind ask or deny`,
  );
}
