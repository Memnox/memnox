import {
  DATABASE_SCHEMES,
  KNOWN_TOOLS,
  PRODUCTION_HINTS,
  RESOURCE_KIND,
  SENSITIVITY,
  SURFACE_KIND,
} from './discovery.constants';
import type { MachineReader } from './ports';
import { fingerprint, type Resource } from './resource';
import type { Surface } from './surface';

/**
 * A command-line tool an agent with a shell can invoke. Everything an agent reaches
 * through one of these is reachable whether or not Memnox can see the call.
 */
export interface DiscoveredTool {
  name: string;
  /** The path that proved it. A tool with no evidence is a guess. */
  detectedFrom: string;
}

/** Looked for where they install, never assumed from a list. */
export async function detectTools(reader: MachineReader): Promise<DiscoveredTool[]> {
  const found: DiscoveredTool[] = [];
  for (const tool of KNOWN_TOOLS) {
    for (const path of tool.paths) {
      if (!(await reader.exists(path))) continue;
      found.push({ name: tool.name, detectedFrom: path });
      break;
    }
  }
  return found;
}

/**
 * A connection string names a database an agent can reach. The scheme and whether the
 * host reads as production is all that is kept: the URL holds a credential, and the
 * value never leaves the process that read it.
 */
export function databasesIn(contents: string, declaredIn: string): Resource[] {
  const found: Resource[] = [];
  const seen = new Set<string>();

  for (const scheme of DATABASE_SCHEMES) {
    const pattern = new RegExp(`\\b${scheme}://([^\\s'"]+)`, 'gi');
    for (const match of contents.matchAll(pattern)) {
      const rest = match[1];
      if (rest === undefined) continue;

      const host = hostOf(rest);
      const production = PRODUCTION_HINTS.some((hint) => host.includes(hint));
      const label = `${scheme}${production ? ' production URL' : ' URL'}`;
      if (seen.has(label)) continue;
      seen.add(label);

      found.push({
        // Keyed on the label and the file, never on the URL it came from.
        id: `res_${fingerprint(`${declaredIn}:${label}`)}`,
        kind: RESOURCE_KIND.DB,
        path: label,
        declaredIn,
        sensitivity: production ? SENSITIVITY.CRITICAL : SENSITIVITY.SENSITIVE,
        reachableBy: [],
      });
    }
  }
  return found;
}

/** The host, with any credential in front of it dropped rather than carried. */
function hostOf(rest: string): string {
  const afterCredential = rest.includes('@') ? rest.slice(rest.indexOf('@') + 1) : rest;
  return afterCredential.split(/[:/?]/)[0]?.toLowerCase() ?? '';
}

/**
 * An agent that can run a shell or reach HTTP already reaches everything on the network,
 * and saying so plainly is most of the value of the map. Derived from the surfaces
 * detected, never asserted.
 */
export function networkReach(surfaces: readonly Surface[]): Resource | null {
  const reaching = surfaces.filter(
    (surface) =>
      surface.kind === SURFACE_KIND.SHELL || surface.kind === SURFACE_KIND.NETWORK,
  );
  if (reaching.length === 0) return null;

  return {
    id: 'res_network',
    kind: RESOURCE_KIND.NETWORK,
    path: 'network',
    declaredIn: 'unrestricted',
    sensitivity: SENSITIVITY.SENSITIVE,
    reachableBy: [],
  };
}
