/** One MCP server the scan named: what it declares, and what it can reach. */

import type { DiscoveryReport, McpTool, Policy } from '@memnox/core';
import {
  classifyToolCall,
  DECISION_EFFECT,
  EFFECT_PRECEDENCE,
  LocalGate,
  TOOL_EFFECT,
  type DecisionEffect,
} from '@memnox/core';

import type { CliContext } from '../../cli-context';

export interface ExplainedServer {
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
  /** What the rules in force decide for each tool, by name, as the proxy would ask. */
  verdicts?: Record<string, ToolVerdict>;
}

export interface ToolVerdict {
  effect: DecisionEffect;
  /** The rule that decided it; absent is "no rule", which is not the same as allowed. */
  rule?: string;
}

/**
 * Each tool asked of the engine under both names the seams use, the strictest winning,
 * so this screen is what a call would meet rather than what a rule file says.
 */
export function withVerdicts(
  server: ExplainedServer,
  policies: readonly Policy[],
): ExplainedServer {
  const gate = new LocalGate([...policies], { agentName: 'agent' });
  const verdicts: Record<string, ToolVerdict> = {};
  for (const tool of server.tools) {
    const toolClass = classifyToolCall(tool.name).class;
    const worst = [`mcp.${tool.name}`, `mcp.${server.name}.${tool.name}`]
      .map((action) => gate.evaluate({ action, target: server.name, toolClass }))
      .reduce((strictest, each) =>
        EFFECT_PRECEDENCE[each.effect] > EFFECT_PRECEDENCE[strictest.effect]
          ? each
          : strictest,
      );
    const rule = worst.matchedPolicies[0]?.name;
    verdicts[tool.name] = {
      effect: worst.effect,
      ...(rule === undefined ? {} : { rule }),
    };
  }
  return { ...server, verdicts };
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
  const verdicts = server.verdicts ?? {};
  flow.table(
    'Holds',
    ['Tool', 'Effect', 'Verdict', 'Rule'],
    server.tools.map((tool) => {
      const verdict = verdicts[tool.name];
      return [
        tool.name,
        tool.effect === TOOL_EFFECT.DESTRUCTIVE
          ? style.warn(tool.effect)
          : style.dim(tool.effect),
        verdict === undefined
          ? ''
          : style.effect(verdict.effect, verdict.effect.toUpperCase()),
        verdict?.rule ?? style.dim('no rule'),
      ];
    }),
  );
  flow.close(
    `${server.tools.length} tool(s) on ${server.name}. ${verdictCounts(verdicts)}`,
  );
  flow.hint(
    `memnox protect --for ${server.name}   put the dangerous ones behind ask or deny`,
  );
}

/** Counts, never a score: how many a call would meet as allowed, asked and refused. */
function verdictCounts(verdicts: Readonly<Record<string, ToolVerdict>>): string {
  const all = Object.values(verdicts);
  const counted = new Map<DecisionEffect, number>();
  for (const each of all) counted.set(each.effect, (counted.get(each.effect) ?? 0) + 1);
  const unruled = all.filter((each) => each.rule === undefined).length;
  return [
    `${counted.get(DECISION_EFFECT.ALLOW) ?? 0} allowed`,
    `${counted.get(DECISION_EFFECT.ASK) ?? 0} asked`,
    `${counted.get(DECISION_EFFECT.DENY) ?? 0} refused`,
    `${unruled} with no rule.`,
  ].join(', ');
}
