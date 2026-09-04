import type { AgentRef } from './agent';
import type { Resource } from './resource';
import {
  FINDING_SEVERITY,
  HARDEN_MODE,
  HARDEN_TARGET,
  SENSITIVITY,
  SEVERITY_ORDER,
  type FindingSeverity,
  type HardenMode,
  type HardenTarget,
  type SurfaceKind,
} from './discovery.constants';

/**
 * Every step prints its undo before it runs, and a single command puts the machine
 * back. Irreversible hardening is the one failure this product does not recover from.
 */
export interface HardenStep {
  id: string;
  target: HardenTarget;
  /** The seam it lands on; policy steps name the surface the rule is about. */
  seam: SurfaceKind;
  description: string;
  /** What running it does, and the exact inverse. Both, always. */
  apply: HardenChange;
  revert: HardenChange;
  appliedAt?: string;
  revertedAt?: string;
  mode: HardenMode;
}

/** A file written or removed. Nothing lands in a file the reader's team reviews. */
export interface HardenChange {
  path: string;
  /** Absent means the file is removed. */
  contents?: string;
  /** Printed before anything runs, so the undo is visible first. */
  command: string;
}

export interface Finding {
  id: string;
  severity: FindingSeverity;
  title: string;
  agentIds: string[];
  resourceId?: string;
  /** The file that proved it. A finding with no evidence is an opinion. */
  evidence: string;
  remediation?: HardenStep;
}

const SENSITIVITY_SEVERITY: Record<string, FindingSeverity> = {
  [SENSITIVITY.CRITICAL]: FINDING_SEVERITY.CRITICAL,
  [SENSITIVITY.SENSITIVE]: FINDING_SEVERITY.HIGH,
  [SENSITIVITY.ORDINARY]: FINDING_SEVERITY.LOW,
};

/**
 * Ranked by consequence, and by whether the reach is used — which is unknown until a
 * day of observation exists, and is therefore assumed present.
 */
export function rankFindings(findings: readonly Finding[]): Finding[] {
  return [...findings].sort((a, b) => {
    const bySeverity = SEVERITY_ORDER[b.severity] - SEVERITY_ORDER[a.severity];
    if (bySeverity !== 0) return bySeverity;
    const byReach = b.agentIds.length - a.agentIds.length;
    if (byReach !== 0) return byReach;
    return a.id.localeCompare(b.id);
  });
}

export function severityOfResource(resource: Resource): FindingSeverity {
  return SENSITIVITY_SEVERITY[resource.sensitivity] ?? FINDING_SEVERITY.LOW;
}

export function agentIdsOf(refs: readonly AgentRef[]): string[] {
  return refs.map((ref) => ref.id);
}

export const DEFAULT_HARDEN_MODE: HardenMode = HARDEN_MODE.ADVISE;
export const DEFAULT_HARDEN_TARGET: HardenTarget = HARDEN_TARGET.POLICY;
