import { LINEAGE_CONFIDENCE, type LineageMethod } from './ledger.constants';

/** A person, through a tool, through an agent, through a repository, to a system. */
export interface LineageHop {
  at: string;
  actorId: string;
  actorKind: string;
  system: string;
  ref?: string;
  /** Marking an inferred hop as inferred keeps the feature credible when it is wrong. */
  method: LineageMethod;
  confidence: number;
}

export interface Lineage {
  correlationId: string;
  hops: LineageHop[];
}

export interface HopObservation {
  at: string;
  actorId: string;
  actorKind: string;
  system: string;
  ref?: string;
  correlationId?: string;
  method: LineageMethod;
}

/**
 * Joined on the correlation id where it was carried, and on actor plus time where it
 * was not. Cross-system causation cannot be propagated everywhere, so the method rides
 * on every hop rather than being asserted once for the chain.
 */
export function assembleLineage(
  correlationId: string,
  observations: readonly HopObservation[],
): Lineage {
  const belongs = observations.filter(
    (each) => each.correlationId === correlationId || each.correlationId === undefined,
  );
  const hops = belongs
    .map((each) => ({
      at: each.at,
      actorId: each.actorId,
      actorKind: each.actorKind,
      system: each.system,
      ...(each.ref === undefined ? {} : { ref: each.ref }),
      method: each.method,
      confidence: LINEAGE_CONFIDENCE[each.method],
    }))
    .sort((a, b) => a.at.localeCompare(b.at));
  return { correlationId, hops };
}

/** A chain is only as good as its weakest hop, and saying so is the honest report. */
export function lineageConfidence(lineage: Lineage): number {
  if (lineage.hops.length === 0) return 0;
  return Math.min(...lineage.hops.map((hop) => hop.confidence));
}
