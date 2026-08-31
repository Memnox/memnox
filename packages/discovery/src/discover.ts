import { join } from 'node:path';
import type { DiscoveredAgent, AgentRef } from './agent';
import { agentRefOf } from './agent';
import type { AgentDetector } from './detectors/detector';
import { DEFAULT_DETECTORS } from './detectors/index';
import type { MachineReader } from './ports';
import {
  classifyResourceKind,
  classifySensitivity,
  fingerprint,
  type Resource,
} from './resource';
import { SENSITIVITY, SURFACE_KIND } from './discovery.constants';
import type { Surface } from './surface';
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

export interface DiscoveryReport {
  agents: DiscoveredAgent[];
  surfaces: Surface[];
  resources: Resource[];
  reachability: Reachability[];
  /** What was opened and why, so the tool that inspects credentials is itself inspectable. */
  read: string[];
}

export interface DiscoveryOptions {
  detectors?: readonly AgentDetector[];
  /** Injected so a report is reproducible; never read off a clock inside the run. */
  now: string;
}

/**
 * Everything here is read off the disk, which is the only aggregate that is true at
 * minute zero. Nothing opens a socket outward and nothing is transmitted.
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

  const { resources, read } = await scanResources(reader);
  const refs: AgentRef[] = agents.map(agentRefOf);
  const reachability = computeReachability(refs, surfaces, resources);

  return {
    agents,
    surfaces,
    resources: attributeResources(resources, reachability, refs),
    reachability,
    read,
  };
}

/**
 * Finding a credential requires reading the file it lives in. The value stays in this
 * function: what leaves is a path, a kind and a hash, so nothing downstream can leak
 * what it never received.
 */
async function scanResources(
  reader: MachineReader,
): Promise<{ resources: Resource[]; read: string[] }> {
  const home = reader.homeDir();
  const resources: Resource[] = [];
  const read: string[] = [];

  for (const relative of CREDENTIAL_PATHS) {
    const path = join(home, relative);
    const contents = await reader.read(path);
    if (contents === null) continue;
    read.push(path);
    resources.push({
      id: `res_${fingerprint(path)}`,
      kind: classifyResourceKind(path),
      path,
      fingerprint: fingerprint(contents),
      sensitivity: classifySensitivity(path),
      reachableBy: [],
    });
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
