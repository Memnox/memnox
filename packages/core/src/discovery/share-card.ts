import type { CapabilityInventory } from './inventory';
import { changesExternalState } from './classify';

/**
 * Counts only. No path, no tool name, no host, no server name — somebody sharing this
 * is sharing a shape, not an inventory of their machine. The temptation is to include
 * "github" because it seems harmless; on a private repo the name is the leak.
 */
export interface ShareCard {
  agents: number;
  servers: number;
  tools: number;
  externalState: number;
  sensitivePathsReachable: number;
  credentialsReachable: number;
  shellSurfaces: number;
  /** Principals behind the agent rows: a harness is one row and several of these. */
  principals: number;
  /** Paths a set of ordinary tools opens together. A count, never the tools. */
  combinedPaths: number;
}

export function shareCardFor(inventory: CapabilityInventory): ShareCard {
  return {
    agents: inventory.agents.length,
    servers: inventory.mcpServers.length,
    tools: inventory.tools.length,
    externalState: inventory.tools.filter((tool) => changesExternalState(tool.class))
      .length,
    sensitivePathsReachable: inventory.filesystem.filter(
      (entry) => entry.sensitivity !== 'ordinary' && entry.reachableBy.length > 0,
    ).length,
    credentialsReachable: inventory.credentials.filter(
      (entry) => entry.reachableBy.length > 0,
    ).length,
    shellSurfaces: inventory.shell.length,
    principals:
      inventory.agents.length -
      inventory.harnesses.length +
      inventory.harnesses.reduce(
        (total, harness) => total + Math.max(1, harness.roles.length),
        0,
      ),
    combinedPaths: inventory.chains.filter((chain) => chain.individuallyHarmless).length,
  };
}

const WIDTH = 46;

function row(label: string, value: string): string {
  const dots = '.'.repeat(Math.max(1, WIDTH - label.length - value.length - 4));
  return `  ${label} ${dots} ${value}`;
}

/** Plain text, so it pastes into anything and nothing has to render it. */
export function renderShareCard(card: ShareCard): string {
  return [
    '┌' + '─'.repeat(WIDTH) + '┐',
    '  What can act on my laptop right now',
    '',
    row('AI agents installed', String(card.agents)),
    row('MCP servers', String(card.servers)),
    row('tools they expose', String(card.tools)),
    row('...that change external state', String(card.externalState)),
    '',
    row('credentials an agent can reach', String(card.credentialsReachable)),
    row('sensitive paths an agent can reach', String(card.sensitivePathsReachable)),
    row('agents holding a shell', String(card.shellSurfaces)),
    ...(card.principals === card.agents
      ? []
      : [row('principals behind those agents', String(card.principals))]),
    ...(card.combinedPaths === 0
      ? []
      : [row('paths ordinary tools open together', String(card.combinedPaths))]),
    '',
    '  Counts only — no paths, no names, nothing identifying.',
    '  Run it yourself:  npx memnox',
    '└' + '─'.repeat(WIDTH) + '┘',
    '',
  ].join('\n');
}
