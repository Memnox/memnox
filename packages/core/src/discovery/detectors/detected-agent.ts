import { agentIdFor, type DiscoveredAgent } from '../agent';
import {
  SURFACE_KIND,
  type DiscoveredAgentKind,
  type SurfaceKind,
} from '../discovery.constants';
import type { MachineReader } from '../ports';
import type { McpServerLaunch, Surface } from '../surface';

/** The roster row and surfaces every detector builds, in one shape rather than one per product. */
interface DetectedAgentInput {
  kind: DiscoveredAgentKind;
  /** The files that proved it, so a detection can be argued with. */
  configPaths: string[];
  clients: string[];
  reader: MachineReader;
  now: string;
}

export function buildDetectedAgent(input: DetectedAgentInput): DiscoveredAgent {
  return {
    id: agentIdFor(input.kind),
    kind: input.kind,
    configPaths: input.configPaths,
    clients: input.clients,
    ownerHint: input.reader.userName(),
    firstSeen: input.now,
    lastSeen: input.now,
  };
}

/** Surfaces a product has by construction, each pointing at the file that proved it. */
export function buildSurfaces(
  agentId: string,
  kinds: readonly SurfaceKind[],
  detectedFrom: string,
): Surface[] {
  return kinds.map((kind) => ({ agentId, kind, detectedFrom }));
}

/** The MCP surface, or nothing when the config declares no server. */
export function buildMcpSurfaces(
  agentId: string,
  detectedFrom: string,
  servers: McpServerLaunch[],
): Surface[] {
  if (servers.length === 0) return [];
  return [{ agentId, kind: SURFACE_KIND.MCP, detectedFrom, tools: [], servers }];
}
