import type { DiscoveryReport } from './discover';
import { URL_SERVER_COMMAND } from './detectors/mcp-config';
import type { McpServerLaunch, Surface } from './surface';
import { isOwnServer, isWrapped } from './wrap';
import {
  EFFECT_INFERENCE,
  SURFACE_KIND,
  type ResourceKind,
  type Sensitivity,
  type SurfaceKind,
  type ToolEffect,
} from './discovery.constants';

/**
 * What the machine held at one moment, reduced to the fields a later comparison can
 * read. Never the whole report: a snapshot is kept for weeks, so it carries names,
 * counts and fingerprints and nothing that was inside a file.
 */
export interface EnvironmentSnapshot {
  takenAt: string;
  agents: SnapshotAgent[];
  servers: SnapshotServer[];
  resources: SnapshotResource[];
}

export interface SnapshotAgent {
  id: string;
  kind: string;
  /** So an update is named as the cause of what it changed, rather than raised as an alarm. */
  version?: string;
  /** One entry per surface kind, so a widened surface is a comparison and not a guess. */
  surfaces: SnapshotSurface[];
  /**
   * Present only for a harness. A role that appeared overnight is the drift a
   * per-agent roster cannot see, so the membership is kept rather than the count.
   */
  harness?: SnapshotHarness;
}

export interface SnapshotHarness {
  runtimes: string[];
  roles: string[];
  hooks: string[];
  federated: boolean;
}

export interface SnapshotSurface {
  kind: SurfaceKind;
  /** The file that proved it, which is the answer to "who granted this". */
  detectedFrom: string;
}

export interface SnapshotServer {
  name: string;
  /** The config file that launches it. Provenance for authority, not just for code. */
  grantedBy: string;
  agentIds: string[];
  tools: SnapshotTool[];
  /**
   * Whether every config that launches it routes it through the proxy. One agent
   * launching it bare is enough to make it ungoverned, because that agent reaches it
   * with nothing in the way. Absent on snapshots kept before this was recorded.
   */
  wrapped?: boolean;
  /** How it is reached. A launch line is stdio; a server named by URL is http. */
  transport?: McpTransport;
}

export const MCP_TRANSPORT = {
  STDIO: 'stdio',
  HTTP: 'http',
} as const;

export type McpTransport = (typeof MCP_TRANSPORT)[keyof typeof MCP_TRANSPORT];

export interface SnapshotTool {
  name: string;
  effect: ToolEffect;
}

export interface SnapshotResource {
  id: string;
  kind: ResourceKind;
  /** Absent for a resource that is not a file, such as the network or a database URL. */
  path?: string;
  sensitivity: Sensitivity;
  reachableBy: string[];
}

/** Reduces a report to what survives being kept. Pure: the clock is an argument. */
export function snapshotOf(
  report: DiscoveryReport,
  takenAt: string,
): EnvironmentSnapshot {
  return {
    takenAt,
    agents: report.agents.map((agent) => {
      const harness = report.harnesses.find((each) => each.agentId === agent.id);
      return {
        id: agent.id,
        kind: agent.kind,
        ...(agent.version === undefined ? {} : { version: agent.version }),
        surfaces: report.surfaces
          .filter((surface) => surface.agentId === agent.id)
          .map((surface) => ({
            kind: surface.kind,
            detectedFrom: surface.detectedFrom,
          })),
        ...(harness === undefined
          ? {}
          : {
              harness: {
                runtimes: [...harness.runtimes],
                roles: [...harness.roles],
                hooks: [...harness.hooks],
                federated: harness.federated,
              },
            }),
      };
    }),
    servers: serversIn(report),
    resources: report.resources.map((resource) => ({
      id: resource.id,
      kind: resource.kind,
      ...(resource.path === undefined ? {} : { path: resource.path }),
      sensitivity: resource.sensitivity,
      reachableBy: resource.reachableBy.map((ref) => ref.id),
    })),
  };
}

/** Through the proxy, or Memnox's own server, which needs nothing in front of it. */
function isGoverned(launch: Parameters<typeof isWrapped>[0]): boolean {
  return isWrapped(launch) || isOwnServer(launch);
}

/** One row per server, whichever agents launch it, with the config that named it. */
function serversIn(report: DiscoveryReport): SnapshotServer[] {
  const byName = new Map<string, SnapshotServer>();

  for (const surface of report.surfaces) {
    if (surface.kind !== SURFACE_KIND.MCP) continue;
    for (const launch of surface.servers ?? []) {
      const existing = byName.get(launch.name);
      if (existing === undefined) {
        byName.set(launch.name, {
          name: launch.name,
          grantedBy: surface.detectedFrom,
          agentIds: [surface.agentId],
          tools: [],
          wrapped: isGoverned(launch),
          transport: transportOf(launch),
        });
        continue;
      }
      if (!existing.agentIds.includes(surface.agentId)) {
        existing.agentIds.push(surface.agentId);
      }
      // One bare launch is an agent with nothing in its way, so it decides.
      existing.wrapped = existing.wrapped === true && isGoverned(launch);
    }
    for (const tool of surface.tools ?? []) {
      const server = byName.get(tool.server);
      if (server === undefined) continue;
      if (server.tools.some((each) => each.name === tool.name)) continue;
      server.tools.push({ name: tool.name, effect: tool.effect });
    }
  }
  return [...byName.values()];
}

/** Names only: the URL itself can carry a token, so it never leaves this function. */
function transportOf(launch: McpServerLaunch): McpTransport {
  return launch.command === URL_SERVER_COMMAND ? MCP_TRANSPORT.HTTP : MCP_TRANSPORT.STDIO;
}

/**
 * The tools a probed scan found, put back onto the surfaces of an unprobed one, because
 * only `scan` starts MCP servers and `doctor` and `protect` still need to know the tools.
 */
export function withToolsFrom(
  surfaces: readonly Surface[],
  snapshot: EnvironmentSnapshot | null,
): Surface[] {
  if (snapshot === null) return [...surfaces];
  return surfaces.map((surface) => {
    if ((surface.tools ?? []).length > 0) return surface;
    const names = new Set((surface.servers ?? []).map((server) => server.name));
    if (names.size === 0) return surface;
    const tools = snapshot.servers
      .filter(
        (server) => names.has(server.name) && server.agentIds.includes(surface.agentId),
      )
      .flatMap((server) =>
        server.tools.map((tool) => ({
          server: server.name,
          name: tool.name,
          effect: tool.effect,
          // Read back from a record rather than inferred here, and it says so.
          inferredFrom: EFFECT_INFERENCE.PROBE,
        })),
      );
    return tools.length === 0 ? surface : { ...surface, tools };
  });
}

/** The newest snapshot that actually enumerated tools, or null when none ever did. */
export function lastProbed(
  history: readonly EnvironmentSnapshot[],
): EnvironmentSnapshot | null {
  for (let at = history.length - 1; at >= 0; at -= 1) {
    const snapshot = history[at] as EnvironmentSnapshot;
    if (snapshot.servers.some((server) => server.tools.length > 0)) return snapshot;
  }
  return null;
}
