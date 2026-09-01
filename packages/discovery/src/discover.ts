import { join } from 'node:path';
import type { DiscoveredAgent, AgentRef } from './agent';
import { agentRefOf } from './agent';
import type { AgentDetector } from './detectors/detector';
import { DEFAULT_DETECTORS } from './detectors/index';
import type { MachineReader, McpLister } from './ports';
import {
  classifyResourceKind,
  classifySensitivity,
  fingerprint,
  type Resource,
} from './resource';
import { SENSITIVITY, SURFACE_KIND } from './discovery.constants';
import { toMcpTool, type Surface } from './surface';
import {
  databasesIn,
  detectTools,
  networkReach,
  type DiscoveredTool,
} from './reach-detail';
import {
  attributeResources,
  computeReachability,
  type Reachability,
} from './reachability';

/** Paths worth opening. Every one of them is read to be protected, never to be kept. */
const CREDENTIAL_PATHS: readonly string[] = [
  '.aws/credentials',
  '.ssh/id_rsa',
  '.ssh/id_ed25519',
  '.kube/config',
  '.docker/config.json',
  '.npmrc',
  '.netrc',
  '.env',
];

/** Sockets an agent with a shell can drive, which is the whole host. */
const SOCKET_PATHS: readonly string[] = ['/var/run/docker.sock'];

/** Credential files that live beside the work rather than in the home directory. */
const PROJECT_CREDENTIAL_FILES: readonly string[] = [
  '.env',
  '.env.local',
  '.env.production',
  '.npmrc',
];

/** A checkout is a resource in its own right: an agent with it can push. */
const REPOSITORY_MARKER = '.git';

export interface DiscoveryReport {
  agents: DiscoveredAgent[];
  surfaces: Surface[];
  resources: Resource[];
  reachability: Reachability[];
  /** What was opened and why, so the tool that inspects credentials is itself inspectable. */
  read: string[];
  /** Servers this run started to ask what they hold, named for the same reason. */
  probed: string[];
  /** Command-line tools an agent with a shell can invoke, each with what proved it. */
  tools: DiscoveredTool[];
}

export interface DiscoveryOptions {
  detectors?: readonly AgentDetector[];
  /**
   * Directories the reader actually works in. The home directory holds the credentials
   * a person has; these hold the ones a repository has, and the doc's opening screen
   * counts both.
   */
  projectDirs?: readonly string[];
  /** Injected so a report is reproducible; never read off a clock inside the run. */
  now: string;
  /**
   * Omit and every MCP surface reports its servers with no tools, which is honest and
   * useless. Supplied, each server is started and asked — the only thing here that
   * runs somebody else's code, so the caller decides.
   */
  lister?: McpLister;
}

/**
 * Read off the disk, which is the only aggregate true at minute zero. Nothing is
 * transmitted and nothing opens a socket outward; with a lister it does start the MCP
 * servers this machine already launches, and names each one it started.
 */
export async function discover(
  reader: MachineReader,
  options: DiscoveryOptions,
): Promise<DiscoveryReport> {
  const detectors = options.detectors ?? DEFAULT_DETECTORS;
  const agents: DiscoveredAgent[] = [];
  const surfaces: Surface[] = [];

  for (const detector of detectors) {
    const found = await detector.detect(reader, options.now);
    if (found === null) continue;
    agents.push(found.agent);
    surfaces.push(...found.surfaces);
  }

  const probed = await enumerateTools(surfaces, options.lister);
  const { resources, read } = await scanResources(reader, options.projectDirs ?? []);

  // Derived from the surfaces already found, never asserted on its own.
  const network = networkReach(surfaces);
  if (network !== null) resources.push(network);

  const refs: AgentRef[] = agents.map(agentRefOf);
  const reachability = computeReachability(refs, surfaces, resources);

  return {
    agents,
    surfaces,
    resources: attributeResources(resources, reachability, refs),
    reachability,
    read,
    probed,
    tools: await detectTools(reader),
  };
}

/**
 * Every server, every tool, and whether each tool reads, writes or destroys — which no
 * client shows anywhere. One server that will not start loses its own tools and nobody
 * else's, and what was started is named so the probe is itself inspectable.
 */
async function enumerateTools(
  surfaces: Surface[],
  lister: McpLister | undefined,
): Promise<string[]> {
  if (lister === undefined) return [];
  const probed: string[] = [];

  for (const surface of surfaces) {
    const servers = surface.servers;
    if (servers === undefined || servers.length === 0) continue;

    const tools = surface.tools ?? [];
    for (const server of servers) {
      probed.push(`${server.name}: ${[server.command, ...server.args].join(' ')}`);
      const declared = await lister.listTools(server.name, server.command, server.args);
      for (const declaration of declared) tools.push(toMcpTool(server.name, declaration));
    }
    surface.tools = tools;
  }
  return probed;
}

/**
 * Finding a credential requires reading the file it lives in. The value stays in this
 * function: what leaves is a path, a kind and a hash, so nothing downstream can leak
 * what it never received.
 */
async function scanResources(
  reader: MachineReader,
  projectDirs: readonly string[],
): Promise<{ resources: Resource[]; read: string[] }> {
  const home = reader.homeDir();
  const resources: Resource[] = [];
  const read: string[] = [];
  const seen = new Set<string>();

  const record = async (path: string): Promise<void> => {
    if (seen.has(path)) return;
    const contents = await reader.read(path);
    if (contents === null) return;
    seen.add(path);
    read.push(path);
    resources.push({
      id: `res_${fingerprint(path)}`,
      kind: classifyResourceKind(path),
      path,
      // The value stays in this function: what leaves is a path, a kind and a hash.
      fingerprint: fingerprint(contents),
      sensitivity: classifySensitivity(path),
      reachableBy: [],
    });
    // A connection string names a database; the scheme is kept and the URL is not.
    resources.push(...databasesIn(contents, path));
  };

  for (const relative of CREDENTIAL_PATHS) await record(join(home, relative));

  for (const dir of projectDirs) {
    for (const file of PROJECT_CREDENTIAL_FILES) await record(join(dir, file));

    // A checkout is reachable in its own right, and it is not opened to be counted.
    const repository = join(dir, REPOSITORY_MARKER);
    if (await reader.exists(repository)) {
      if (seen.has(repository)) continue;
      seen.add(repository);
      resources.push({
        id: `res_${fingerprint(repository)}`,
        kind: classifyResourceKind(repository),
        path: repository,
        sensitivity: classifySensitivity(repository),
        reachableBy: [],
      });
    }
  }

  for (const path of SOCKET_PATHS) {
    if (!(await reader.exists(path))) continue;
    resources.push({
      id: `res_${fingerprint(path)}`,
      kind: classifyResourceKind(path),
      path,
      sensitivity: SENSITIVITY.CRITICAL,
      reachableBy: [],
    });
  }

  return { resources, read };
}

/** Counts and names, not percentages: a percentage here has no denominator. */
export function summarize(report: DiscoveryReport): {
  agents: number;
  surfaces: number;
  tools: number;
  reachableSecrets: number;
} {
  const tools = report.surfaces.reduce(
    (total, surface) => total + (surface.tools ?? []).length,
    0,
  );
  const reachableSecrets = report.resources.filter(
    (resource) =>
      resource.sensitivity !== SENSITIVITY.ORDINARY && resource.reachableBy.length > 0,
  ).length;
  return {
    agents: report.agents.length,
    surfaces: report.surfaces.filter((surface) => surface.kind !== SURFACE_KIND.MCP)
      .length,
    tools,
    reachableSecrets,
  };
}
