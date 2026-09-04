import type { AgentRef } from './agent';
import type { DiscoveryReport } from './discover';
import type { Resource } from './resource';
import { PRODUCTION_HINTS, RESOURCE_KIND } from './discovery.constants';

/**
 * One agent that reaches production from a working directory that is not one.
 *
 * The pair matters, not either half: reaching production is ordinary for a deployment
 * agent, and a local checkout is ordinary for everybody. Together they are an agent
 * doing local work with production authority, and that is the thing worth removing.
 */
export interface EnvironmentMismatch {
  agentId: string;
  agentKind: string;
  /** Where the work is happening, which is what makes the reach unnecessary. */
  workingIn: string;
  /** Production resources this agent can reach from there. */
  reaches: MismatchedResource[];
}

export interface MismatchedResource {
  id: string;
  kind: string;
  /** The file that proved it. A mismatch with no evidence is an opinion. */
  declaredIn: string;
}

/**
 * Whether a name reads as production. Deliberately a name test and nothing cleverer:
 * a probe that connected to somebody's database to find out would be this product
 * doing the work instead of governing it.
 */
export function readsAsProduction(resource: Resource): boolean {
  const text = `${resource.id} ${resource.path ?? ''} ${resource.declaredIn ?? ''}`;
  return PRODUCTION_HINTS.some((hint) => text.toLowerCase().includes(hint));
}

/** A directory a person is developing in rather than deploying from. */
function readsAsLocal(directory: string): boolean {
  return !PRODUCTION_HINTS.some((hint) => directory.toLowerCase().includes(hint));
}

/**
 * Reported, never enforced. The recommendation is to remove or protect the reach, and
 * `harden` is where a person chooses one; a scan that quietly narrowed an agent's
 * authority would be exactly the irreversible hardening this product does not do.
 *
 * Limit: it compares a name against a directory. An agent whose production database
 * is called something else is not found here, and nothing about that is guessed at.
 */
export function environmentMismatches(
  report: DiscoveryReport,
  workingDirectories: readonly string[],
): EnvironmentMismatch[] {
  const local = workingDirectories.filter(readsAsLocal);
  if (local.length === 0) return [];

  const production = report.resources.filter(
    (resource) =>
      (resource.kind === RESOURCE_KIND.DB || resource.kind === RESOURCE_KIND.SECRET) &&
      readsAsProduction(resource),
  );
  if (production.length === 0) return [];

  const mismatches: EnvironmentMismatch[] = [];
  for (const agent of report.agents) {
    const reaches = production
      .filter((resource) => reachedBy(resource.reachableBy, agent.id))
      .map((resource) => ({
        id: resource.id,
        kind: resource.kind,
        declaredIn: resource.declaredIn ?? resource.path ?? 'unknown',
      }));
    if (reaches.length === 0) continue;
    mismatches.push({
      agentId: agent.id,
      agentKind: agent.kind,
      workingIn: local[0] ?? '',
      reaches,
    });
  }
  return mismatches;
}

function reachedBy(refs: readonly AgentRef[], agentId: string): boolean {
  return refs.some((ref) => ref.id === agentId);
}
