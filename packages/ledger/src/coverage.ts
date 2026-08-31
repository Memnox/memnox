import type { RiskLevel } from '@memnox/core';
import { RISK_LEVEL } from '@memnox/core';

/** Weighted by risk, or a read loop shows ninety-nine percent while the irreversible go ungoverned. */
export const RISK_WEIGHT: Record<RiskLevel, number> = {
  [RISK_LEVEL.LOW]: 1,
  [RISK_LEVEL.MEDIUM]: 3,
  [RISK_LEVEL.HIGH]: 8,
  [RISK_LEVEL.CRITICAL]: 20,
};

export interface CoverageInput {
  workspaceId: string;
  from: string;
  to: string;
  /** Distinct actions seen and governed, per risk level. */
  byRisk: Record<RiskLevel, { seen: number; governed: number }>;
  seamsCovered: number;
  seamsTotal: number;
  installsEnforcing: number;
  installsTotal: number;
  topUngoverned: string[];
}

export interface CoverageWindow {
  workspaceId: string;
  from: string;
  to: string;
  actionsSeen: number;
  actionsGoverned: number;
  seamsCovered: number;
  seamsTotal: number;
  installsEnforcing: number;
  installsTotal: number;
  byRisk: Record<RiskLevel, { seen: number; governed: number }>;
  topUngoverned: string[];
  /** One number a board can see, defended by the list underneath it. */
  coverage: number;
}

/**
 * Distinct actions governed over distinct actions seen, weighted by risk, times seam
 * coverage, times install coverage. An agent governed on one of four seams is not a
 * governed agent, and thirty-nine machines enforcing with one that is not is a hole.
 */
export function computeCoverage(input: CoverageInput): CoverageWindow {
  let weightedSeen = 0;
  let weightedGoverned = 0;
  let actionsSeen = 0;
  let actionsGoverned = 0;

  for (const [level, counts] of Object.entries(input.byRisk) as [
    RiskLevel,
    { seen: number; governed: number },
  ][]) {
    const weight = RISK_WEIGHT[level];
    weightedSeen += counts.seen * weight;
    weightedGoverned += counts.governed * weight;
    actionsSeen += counts.seen;
    actionsGoverned += counts.governed;
  }

  const actionShare = weightedSeen === 0 ? 0 : weightedGoverned / weightedSeen;
  const seamShare = input.seamsTotal === 0 ? 0 : input.seamsCovered / input.seamsTotal;
  const installShare =
    input.installsTotal === 0 ? 0 : input.installsEnforcing / input.installsTotal;

  return {
    workspaceId: input.workspaceId,
    from: input.from,
    to: input.to,
    actionsSeen,
    actionsGoverned,
    seamsCovered: input.seamsCovered,
    seamsTotal: input.seamsTotal,
    installsEnforcing: input.installsEnforcing,
    installsTotal: input.installsTotal,
    byRisk: input.byRisk,
    topUngoverned: [...input.topUngoverned],
    coverage: actionShare * seamShare * installShare,
  };
}
