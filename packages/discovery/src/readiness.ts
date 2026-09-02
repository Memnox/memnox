import type { DiscoveryReport } from './discover';
import { RESOURCE_KIND, SURFACE_KIND } from './discovery.constants';
import type { ResourceKind, SurfaceKind } from './discovery.constants';

/**
 * One thing an action needs before it can happen at all. Satisfied when the machine
 * holds any one of the named surfaces, tools or resource kinds — the alternatives are
 * genuine alternatives, so `aws` or `kubectl` both answer "something that deploys".
 */
export interface ReadinessNeed {
  label: string;
  surfaces?: readonly SurfaceKind[];
  tools?: readonly string[];
  resources?: readonly ResourceKind[];
}

/**
 * Asked of the machine rather than of the model. An agent asked whether it can deploy
 * answers about its instructions; this answers about its credentials, its tooling and
 * its reach.
 */
export const READINESS_NEEDS: Readonly<Record<string, readonly ReadinessNeed[]>> = {
  deploy: [
    { label: 'a shell to run it in', surfaces: [SURFACE_KIND.SHELL] },
    {
      label: 'a deploy tool on PATH',
      tools: ['aws', 'gcloud', 'kubectl', 'terraform', 'docker'],
    },
    { label: 'credentials it can reach', resources: [RESOURCE_KIND.SECRET] },
    { label: 'a checkout to deploy from', resources: [RESOURCE_KIND.REPO] },
  ],
  database: [
    { label: 'a shell to run it in', surfaces: [SURFACE_KIND.SHELL] },
    { label: 'a database client on PATH', tools: ['psql'] },
    { label: 'a database it can name', resources: [RESOURCE_KIND.DB] },
  ],
  code: [
    { label: 'a filesystem it can write', surfaces: [SURFACE_KIND.FILESYSTEM] },
    { label: 'a checkout to change', resources: [RESOURCE_KIND.REPO] },
  ],
  repository: [
    { label: 'a filesystem it can read', surfaces: [SURFACE_KIND.FILESYSTEM] },
    { label: 'a checkout to read', resources: [RESOURCE_KIND.REPO] },
  ],
  shell: [{ label: 'a shell to run it in', surfaces: [SURFACE_KIND.SHELL] }],
  network: [
    {
      label: 'a way off the machine',
      surfaces: [SURFACE_KIND.NETWORK, SURFACE_KIND.SHELL],
    },
  ],
  mcp: [{ label: 'a server declaring the tool', surfaces: [SURFACE_KIND.MCP] }],
  container: [
    { label: 'the docker socket', resources: [RESOURCE_KIND.SOCKET] },
    { label: 'the docker CLI on PATH', tools: ['docker'] },
  ],
};

export interface ReadinessFinding {
  need: string;
  /** What proved it, named so a wrong answer is arguable rather than mysterious. */
  evidence?: string;
}

export interface Readiness {
  agentId: string;
  agentKind: string;
  action: string;
  has: ReadinessFinding[];
  missing: ReadinessFinding[];
  /**
   * Absent when the action's namespace has no stated needs. An empty list of needs is
   * not the same as a satisfied one, and saying so is cheaper than guessing.
   */
  known: boolean;
}

/**
 * What this agent holds towards this action, off the disk. It answers the first half
 * of "can it deploy"; the rule that still refuses is the second half and belongs to
 * the policy engine, never here.
 */
export function readinessFor(
  report: DiscoveryReport,
  agentId: string,
  action: string,
): Readiness | null {
  const agent = report.agents.find(
    (each) => each.id === agentId || each.kind === agentId,
  );
  if (agent === undefined) return null;

  const namespace = action.split('.')[0] ?? action;
  const needs = READINESS_NEEDS[namespace];
  const surfaces = report.surfaces.filter((surface) => surface.agentId === agent.id);
  const reachable = report.resources.filter((resource) =>
    resource.reachableBy.some((ref) => ref.id === agent.id),
  );

  const has: ReadinessFinding[] = [];
  const missing: ReadinessFinding[] = [];

  for (const need of needs ?? []) {
    const surface = surfaces.find((each) => (need.surfaces ?? []).includes(each.kind));
    if (surface !== undefined) {
      has.push({ need: need.label, evidence: surface.detectedFrom });
      continue;
    }
    const tool = report.tools.find((each) => (need.tools ?? []).includes(each.name));
    if (tool !== undefined) {
      has.push({ need: need.label, evidence: tool.detectedFrom });
      continue;
    }
    const resource = reachable.find((each) => (need.resources ?? []).includes(each.kind));
    if (resource !== undefined) {
      has.push({ need: need.label, evidence: resource.path ?? resource.declaredIn });
      continue;
    }
    missing.push({ need: need.label });
  }

  return {
    agentId: agent.id,
    agentKind: agent.kind,
    action,
    has,
    missing,
    known: needs !== undefined,
  };
}
