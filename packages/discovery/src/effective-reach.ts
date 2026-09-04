import type { DiscoveryReport } from './discover';
import type { Resource } from './resource';
import type { Surface } from './surface';
import {
  RESOURCE_KIND,
  TRANSITIVE_SURFACES,
  type SurfaceKind,
} from './discovery.constants';

/** One step of the path, each carrying the file that proved it. */
export interface ReachHop {
  /** What this step is: the agent, a surface it holds, a credential, the resource. */
  via: string;
  kind: 'agent' | 'surface' | 'credential' | 'resource';
  /** The file that proved this hop. A hop with no evidence would be a guess. */
  evidence: string;
}

/**
 * A reach nobody granted directly.
 *
 * The agent was never given the database. It was given a server, the server was handed
 * a credential, and the credential opens the database. Every permission system in the
 * world answers the first grant and none of them answers the last one, which is why an
 * agent's real authority is routinely larger than anybody's mental model of it.
 */
export interface EffectiveReach {
  agentId: string;
  agentKind: string;
  resourceId: string;
  resourceKind: string;
  /** Agent, then how it got there, then what it arrives at. */
  path: ReachHop[];
  /**
   * Why it is not direct: a shell that reaches everything the user does, or a
   * credential that opens something the agent was never named on.
   */
  because: 'shell' | 'credential';
}

const OPENS: readonly string[] = [RESOURCE_KIND.DB, RESOURCE_KIND.CLOUD];

/**
 * Limit, and it is the important one: this reads configuration, not a cloud account.
 * It can say a credential is present and that a database is named; it cannot say the
 * credential opens that database. The path is reported as what was found on this disk,
 * and a reader is told which hop is inference rather than proof.
 */
export function effectiveReach(report: DiscoveryReport): EffectiveReach[] {
  const found: EffectiveReach[] = [];
  const credentials = report.resources.filter(
    (resource) => resource.kind === RESOURCE_KIND.SECRET,
  );
  const opened = report.resources.filter((resource) => OPENS.includes(resource.kind));

  for (const agent of report.agents) {
    const surfaces = report.surfaces.filter((surface) => surface.agentId === agent.id);
    if (surfaces.length === 0) continue;

    for (const resource of opened) {
      if (namedDirectly(surfaces, resource)) continue;

      const shell = surfaces.find((surface) =>
        TRANSITIVE_SURFACES.includes(surface.kind as SurfaceKind),
      );
      const credential = credentials.find((each) => reachedBy(each, agent.id));

      if (credential !== undefined) {
        found.push({
          agentId: agent.id,
          agentKind: agent.kind,
          resourceId: resource.id,
          resourceKind: resource.kind,
          because: 'credential',
          path: [
            { via: agent.kind, kind: 'agent', evidence: surfaces[0]?.detectedFrom ?? '' },
            {
              via: surfaces[0]?.kind ?? '',
              kind: 'surface',
              evidence: surfaces[0]?.detectedFrom ?? '',
            },
            {
              via: credential.id,
              kind: 'credential',
              evidence: credential.path ?? credential.declaredIn ?? '',
            },
            {
              via: resource.id,
              kind: 'resource',
              evidence: resource.declaredIn ?? resource.path ?? '',
            },
          ],
        });
        continue;
      }

      if (shell !== undefined) {
        found.push({
          agentId: agent.id,
          agentKind: agent.kind,
          resourceId: resource.id,
          resourceKind: resource.kind,
          because: 'shell',
          path: [
            { via: agent.kind, kind: 'agent', evidence: shell.detectedFrom },
            { via: shell.kind, kind: 'surface', evidence: shell.detectedFrom },
            {
              via: resource.id,
              kind: 'resource',
              evidence: resource.declaredIn ?? resource.path ?? '',
            },
          ],
        });
      }
    }
  }
  return found;
}

/** A resource the agent's own surface names is a direct grant, not an effective one. */
function namedDirectly(surfaces: readonly Surface[], resource: Resource): boolean {
  const declared = resource.declaredIn;
  if (declared === undefined) return false;
  return surfaces.some((surface) => surface.detectedFrom === declared);
}

function reachedBy(resource: Resource, agentId: string): boolean {
  return resource.reachableBy.some((ref) => ref.id === agentId);
}
