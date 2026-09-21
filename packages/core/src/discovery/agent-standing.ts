import {
  SEVERITY_ORDER,
  TOOL_EFFECT,
  type FindingSeverity,
  type SurfaceKind,
} from './discovery.constants';
import { countBySeverity, type Finding } from './finding';
import type { McpTool, Surface } from './surface';

/**
 * Agents on this machine ranked by what is configured here, and never a safety rating of
 * the products themselves, which would be a claim about software nobody tested.
 */
export interface AgentStanding {
  agentId: string;
  findings: number;
  /** The list underneath the count, so the ranking can be argued with. */
  bySeverity: Record<FindingSeverity, number>;
  /** Tools it reaches that change external state, write and destructive. */
  externalWriteTools: number;
  /** Named rather than counted: "messaging" is the fact somebody acts on. */
  surfaces: SurfaceKind[];
}

/** Worst finding first, then how many of it, and never a total nobody can argue with. */
export function rankAgents(
  findings: readonly Finding[],
  surfaces: readonly Surface[],
): AgentStanding[] {
  const agentIds = new Set([
    ...findings.flatMap((finding) => finding.agentIds),
    ...surfaces.map((surface) => surface.agentId),
  ]);
  const findingsOf = (agentId: string): Finding[] =>
    findings.filter((finding) => finding.agentIds.includes(agentId));

  return [...agentIds]
    .map((agentId) => standingOf(agentId, findingsOf(agentId), surfaces))
    .sort((a, b) => {
      const worst = worstOf(findingsOf(b.agentId)) - worstOf(findingsOf(a.agentId));
      if (worst !== 0) return worst;
      const many = b.findings - a.findings;
      return many !== 0 ? many : a.agentId.localeCompare(b.agentId);
    });
}

function standingOf(
  agentId: string,
  own: readonly Finding[],
  surfaces: readonly Surface[],
): AgentStanding {
  const ownSurfaces = surfaces.filter((surface) => surface.agentId === agentId);
  return {
    agentId,
    findings: own.length,
    bySeverity: countBySeverity(own),
    externalWriteTools: ownSurfaces
      .flatMap((surface) => surface.tools ?? [])
      .filter(isExternalWrite).length,
    surfaces: [...new Set(ownSurfaces.map((surface) => surface.kind))].sort(),
  };
}

function isExternalWrite(tool: McpTool): boolean {
  return tool.effect === TOOL_EFFECT.WRITE || tool.effect === TOOL_EFFECT.DESTRUCTIVE;
}

/** Worst severity present, for ordering only; -1 when nothing was found. */
function worstOf(findings: readonly Finding[]): number {
  return findings.reduce(
    (worst, finding) => Math.max(worst, SEVERITY_ORDER[finding.severity]),
    -1,
  );
}
