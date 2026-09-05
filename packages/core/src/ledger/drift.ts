/** An agent that was safe last week may not be. Compared against its own baseline. */
export interface DriftBaseline {
  subjectId: string;
  windowDays: number;
  surfaces: string[];
  destinations: string[];
  tools: string[];
  models: string[];
  computedAt: string;
}

export interface DriftFinding {
  subjectId: string;
  against: DriftBaseline;
  added: {
    surfaces: string[];
    destinations: string[];
    tools: string[];
    models: string[];
  };
  /**
   * A widened agent is usually somebody installing a tool, not an attack. Naming the
   * cause makes the common case a change to approve, so the rare case stands out.
   */
  cause?: string;
  authorityDelta: number;
  severity: 'low' | 'medium' | 'high';
}

export interface DriftObservation {
  subjectId: string;
  surfaces: string[];
  destinations: string[];
  tools: string[];
  models: string[];
}

export function computeDrift(
  baseline: DriftBaseline,
  observed: DriftObservation,
  cause?: string,
): DriftFinding | null {
  const added = {
    surfaces: newIn(baseline.surfaces, observed.surfaces),
    destinations: newIn(baseline.destinations, observed.destinations),
    tools: newIn(baseline.tools, observed.tools),
    models: newIn(baseline.models, observed.models),
  };
  const authorityDelta =
    added.surfaces.length +
    added.destinations.length +
    added.tools.length +
    added.models.length;
  if (authorityDelta === 0) return null;

  return {
    subjectId: baseline.subjectId,
    against: baseline,
    added,
    ...(cause === undefined ? {} : { cause }),
    authorityDelta,
    // An explained widening is a change to approve; an unexplained one is worth a look.
    severity: cause !== undefined ? 'low' : authorityDelta > 2 ? 'high' : 'medium',
  };
}

function newIn(before: readonly string[], after: readonly string[]): string[] {
  const known = new Set(before);
  return after.filter((value) => !known.has(value)).sort();
}
