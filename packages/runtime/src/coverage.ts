import type { ActionEvent, RiskLevel, Seam } from '@memnox/core';
import { ENFORCEMENT_MODE, RISK_LEVEL } from '@memnox/core';
import { computeCoverage, type CoverageWindow } from '@memnox/ledger';

/** How many ungoverned actions the report names before it stops listing them. */
export const TOP_UNGOVERNED = 5;

export interface CoverageInputs {
  workspaceId: string;
  events: readonly ActionEvent[];
  seams: readonly Seam[];
  installsEnforcing: number;
  installsTotal: number;
  from?: string;
  to?: string;
}

/**
 * Distinct actions, not decision counts. A read loop firing ten thousand times is one
 * governed action, and counting the calls would let it drown out every irreversible
 * action in the company.
 */
export function coverageFrom(inputs: CoverageInputs): CoverageWindow {
  const seen = new Map<string, { risk: RiskLevel; governed: boolean }>();

  for (const event of inputs.events) {
    // Outcome events are testimony about a decision, not a decision of their own.
    if (event.decisionEventId !== undefined) continue;
    const existing = seen.get(event.action);
    const governed = event.matchedPolicies.length > 0;
    if (existing === undefined) {
      seen.set(event.action, { risk: event.riskLevel, governed });
      continue;
    }
    // Governed once is governed: a rule covers the action, not the occurrence.
    if (governed) existing.governed = true;
  }

  const byRisk: Record<RiskLevel, { seen: number; governed: number }> = {
    [RISK_LEVEL.LOW]: { seen: 0, governed: 0 },
    [RISK_LEVEL.MEDIUM]: { seen: 0, governed: 0 },
    [RISK_LEVEL.HIGH]: { seen: 0, governed: 0 },
    [RISK_LEVEL.CRITICAL]: { seen: 0, governed: 0 },
  };
  const ungoverned: string[] = [];

  for (const [action, entry] of seen) {
    const bucket = byRisk[entry.risk];
    bucket.seen += 1;
    if (entry.governed) bucket.governed += 1;
    else ungoverned.push(action);
  }

  const enforcing = inputs.seams.filter(
    (seam) => seam.mode === ENFORCEMENT_MODE.ENFORCE,
  ).length;

  return computeCoverage({
    workspaceId: inputs.workspaceId,
    from: inputs.from ?? '',
    to: inputs.to ?? '',
    byRisk,
    seamsCovered: enforcing,
    seamsTotal: inputs.seams.length,
    installsEnforcing: inputs.installsEnforcing,
    installsTotal: inputs.installsTotal,
    topUngoverned: ungoverned.slice(0, TOP_UNGOVERNED),
  });
}

/** Everything a seam cannot see, so coverage is never read as completeness. */
export function blindSpots(seams: readonly Seam[]): string[] {
  return [...new Set(seams.flatMap((seam) => seam.blindTo))];
}
