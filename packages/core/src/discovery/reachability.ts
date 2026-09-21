import type { AgentRef } from './agent';
import { classifyResourceKind, type Resource } from './resource';
import type { Surface } from './surface';
import { TRANSITIVE_SURFACES, type SurfaceKind } from './discovery.constants';

/**
 * Which agents can reach which resources, joined from what the probes proved, and counted
 * once per agent per resource so one fact never carries two numbers.
 */
export interface Reachability {
  agentId: string;
  /** Counts and names, never percentages: a percentage has no denominator here. */
  resources: Resource[];
  /** True when a shell surface made the closure everything the user can reach. */
  viaShell: boolean;
  surfaces: SurfaceKind[];
}

/** Which surface kind can touch which resource, stated rather than assumed. */
const SURFACE_REACHES: Record<string, readonly string[]> = {
  filesystem: ['file', 'secret', 'repo'],
  git: ['repo'],
  docker: ['socket'],
  cloud: ['cloud'],
  // A shell or an HTTP tool already reaches everything on the network, and the map
  // that left that out understated every coding agent on the machine.
  network: ['cloud', 'network'],
  mcp: ['file', 'secret', 'repo', 'db', 'cloud', 'network'],
  browser: ['network'],
  shell: ['file', 'secret', 'repo', 'db', 'cloud', 'socket', 'network'],
};

/**
 * Reachability is transitive. An agent that can run a shell reaches everything the shell
 * can, and a map that reported only the surface it was configured with would understate
 * every coding agent on the machine.
 */
export function computeReachability(
  agents: readonly AgentRef[],
  surfaces: readonly Surface[],
  resources: readonly Resource[],
): Reachability[] {
  return agents.map((agent) => {
    const own = surfaces.filter((surface) => surface.agentId === agent.id);
    const kinds = own.map((surface) => surface.kind);
    const viaShell = kinds.some((kind) => TRANSITIVE_SURFACES.includes(kind));
    const reachableKinds = new Set(kinds.flatMap((kind) => SURFACE_REACHES[kind] ?? []));
    const reached = resources.filter((resource) => reachableKinds.has(resource.kind));
    return {
      agentId: agent.id,
      resources: reached,
      viaShell,
      surfaces: [...new Set(kinds)],
    };
  });
}

/** Fills in `reachableBy`, so a resource reads from either direction without a second pass. */
export function attributeResources(
  resources: readonly Resource[],
  reachability: readonly Reachability[],
  agents: readonly AgentRef[],
): Resource[] {
  const byId = new Map(agents.map((agent) => [agent.id, agent]));
  return resources.map((resource) => {
    const reachableBy: AgentRef[] = [];
    for (const entry of reachability) {
      if (!entry.resources.some((each) => each.id === resource.id)) continue;
      const ref = byId.get(entry.agentId);
      if (ref !== undefined) reachableBy.push(ref);
    }
    return { ...resource, reachableBy };
  });
}

/**
 * Which agents reach a credential path, counted off the same table the reachable block
 * reads, so one file cannot carry two different counts on one screen.
 */
export function agentsReachingPath(
  path: string,
  agents: readonly AgentRef[],
  surfaces: readonly Surface[],
): AgentRef[] {
  const kind = classifyResourceKind(path);
  return agents.filter((agent) => {
    const kinds = surfaces
      .filter((surface) => surface.agentId === agent.id)
      .flatMap((surface) => SURFACE_REACHES[surface.kind] ?? []);
    return kinds.includes(kind);
  });
}
