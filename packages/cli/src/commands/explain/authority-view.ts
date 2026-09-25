/** Each system an agent reaches, with what its reads and its changes meet under the rules. */
import {
  actionsForCli,
  authorityOf,
  classifyToolCall,
  describeTally,
  EFFECT_PRECEDENCE,
  LocalGate,
  type AgentDestinations,
  type DiscoveryReport,
  type EnvironmentSnapshot,
  type Policy,
  type SystemAuthority,
  type SystemReach,
} from '@memnox/core';

import type { CliContext } from '../../cli-context';

interface AuthorityInput {
  agentKind: string;
  agentId: string;
  report: DiscoveryReport;
  /** The last scan that asked the servers, which is where their tools are known from. */
  last: EnvironmentSnapshot | null;
  policies: readonly Policy[];
}

/** The logged in CLIs its shell reaches, then the MCP servers it is configured with. */
function reachOf(input: AuthorityInput): SystemReach[] {
  const clis = input.report.authenticated.map((cli) => ({
    system: cli.name,
    candidates: actionsForCli(cli.name),
  }));
  const servers = (input.last?.servers ?? [])
    .filter(
      (server) => server.agentIds.includes(input.agentId) && server.tools.length > 0,
    )
    .map((server) => ({
      system: `${server.name} (MCP)`,
      candidates: server.tools.map((tool) => ({
        action: `mcp.${server.name}.${tool.name}`,
        class: classifyToolCall(tool.name).class,
      })),
    }));
  return [...clis, ...servers];
}

export function authorityFor(input: AuthorityInput): SystemAuthority[] {
  const gate = new LocalGate([...input.policies], { agentName: input.agentKind });
  return authorityOf(reachOf(input), (candidate) => {
    // Both names an MCP call is ruled under, the strictest winning, as at the seams.
    const bare = candidate.action.replace(/^mcp\.[^.]+\./, 'mcp.');
    const worst = [...new Set([candidate.action, bare])]
      .map((action) => gate.evaluate({ action, toolClass: candidate.class }))
      .reduce((strictest, each) =>
        EFFECT_PRECEDENCE[each.effect] > EFFECT_PRECEDENCE[strictest.effect]
          ? each
          : strictest,
      );
    return { effect: worst.effect, matched: worst.matchedPolicies.length > 0 };
  });
}

/** The hosts shown by name, newest first; the rest are counted. */
const HOSTS_SHOWN = 5;

/** Where the agent has actually gone through the egress proxy, as watched on this machine. */
export function renderDestinations(
  context: CliContext,
  destinations: AgentDestinations,
): void {
  const { hosts } = destinations;
  if (hosts.length === 0) return;
  const shown = hosts.slice(0, HOSTS_SHOWN);
  context.flow.rows(
    `Hosts it has reached (${hosts.length})`,
    shown.map((host) => ({
      label: host.host,
      value: `${host.count} time(s), first ${host.first.slice(0, 10)}, last ${host.last.slice(0, 10)}`,
    })),
  );
}

export function renderAuthority(
  context: CliContext,
  authority: readonly SystemAuthority[],
): void {
  if (authority.length === 0) return;
  const { flow } = context;
  flow.table(
    'What it may do in each system',
    ['System', 'Reads', 'Changes'],
    authority.map((each) => [
      each.system,
      describeTally(each.reads),
      describeTally(each.changes),
    ]),
  );
}
