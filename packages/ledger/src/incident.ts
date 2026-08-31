import type { ContainmentAction } from '@memnox/core';

export const INCIDENT_STATE = {
  OPEN: 'open',
  CONTAINED: 'contained',
  CLOSED: 'closed',
} as const;

export type IncidentState = (typeof INCIDENT_STATE)[keyof typeof INCIDENT_STATE];

/** An object with a timeline, an owner, the containment taken and the snapshot kept. */
export interface Incident {
  id: string;
  workspaceId: string;
  subjectId: string;
  openedAt: string;
  severity: 'low' | 'medium' | 'high';
  detector?: string;
  /** The frames this was opened on, so the timeline is a read rather than a search. */
  frames: string[];
  containment: ContainmentAction[];
  ownerId?: string;
  state: IncidentState;
  snapshotRef?: string;
}

export const INCIDENT_REFUSAL = {
  NO_OWNER: 'a failure with no owner is a failure nobody is fixing',
} as const;

/** Failure has an owner: a blocked or broken run becomes an incident with a name on it. */
export function assign(incident: Incident, ownerId: string): Incident {
  return { ...incident, ownerId };
}

export function contain(incident: Incident, action: ContainmentAction): Incident {
  return {
    ...incident,
    containment: [...incident.containment, action],
    state: INCIDENT_STATE.CONTAINED,
  };
}

export type CloseOutcome =
  { closed: true; incident: Incident } | { closed: false; reason: string };

/** Closing without an owner would lose who answered for it, which is the whole record. */
export function close(incident: Incident): CloseOutcome {
  if (incident.ownerId === undefined) {
    return { closed: false, reason: INCIDENT_REFUSAL.NO_OWNER };
  }
  return { closed: true, incident: { ...incident, state: INCIDENT_STATE.CLOSED } };
}

/** Every containment this incident took, and every machine none of them reached. */
export function stillUnreached(incident: Incident): string[] {
  return [
    ...new Set(
      incident.containment.flatMap((action) =>
        action.unreached.map((install) => install.hostLabel),
      ),
    ),
  ];
}

export interface EvidenceExport {
  id: string;
  workspaceId: string;
  from: string;
  to: string;
  includes: string[];
  /** Each file hashed, so the export verifies without the product that made it. */
  manifest: Array<{ file: string; sha256: string; rows: number }>;
  checkpoints: string[];
  signature?: string;
}

/** Evidence that cannot be verified outside the product is a screenshot. */
export function isVerifiable(exported: EvidenceExport): boolean {
  if (exported.manifest.length === 0) return false;
  if (exported.checkpoints.length === 0) return false;
  return exported.manifest.every((file) => file.sha256.length > 0);
}
