import type { LineageHop } from './lineage';

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

export const CHAIN_PATTERN = {
  PRIVILEGE_ESCALATION: 'privilege_escalation',
  DATA_MOVEMENT: 'data_movement',
  CREDENTIAL_RELAY: 'credential_relay',
} as const;

export type ChainPattern = (typeof CHAIN_PATTERN)[keyof typeof CHAIN_PATTERN];

export interface ChainFinding {
  correlationId: string;
  hops: { subjectId: string; action: string; at: string }[];
  pattern: ChainPattern;
  severity: 'low' | 'medium' | 'high';
  containmentProposed: boolean;
}

export interface ChainStep {
  subjectId: string;
  action: string;
  at: string;
  /** What the action touched, so a relay of a credential is distinguishable from a read. */
  resourceKind?: string;
}

const ESCALATING_ACTIONS = ['cloud.', 'iam.', 'role.', 'permission.'];
const CREDENTIAL_KINDS = ['secret'];

/**
 * Chains are invisible one action at a time. Each hop is individually permitted, so no
 * local evaluator will ever see one: it takes the joined ledger and the lineage across
 * systems, which is the clearest technical argument for the paid half.
 */
export function detectChain(
  correlationId: string,
  steps: readonly ChainStep[],
  _hops: readonly LineageHop[] = [],
): ChainFinding | null {
  if (steps.length < 2) return null;
  const subjects = new Set(steps.map((step) => step.subjectId));
  if (subjects.size < 2) return null;

  const touchedCredential = steps.some(
    (step) =>
      step.resourceKind !== undefined && CREDENTIAL_KINDS.includes(step.resourceKind),
  );
  const reachedPrivilege = steps.some((step) =>
    ESCALATING_ACTIONS.some((prefix) => step.action.startsWith(prefix)),
  );

  if (!touchedCredential && !reachedPrivilege) return null;

  const pattern =
    touchedCredential && reachedPrivilege
      ? CHAIN_PATTERN.PRIVILEGE_ESCALATION
      : touchedCredential
        ? CHAIN_PATTERN.CREDENTIAL_RELAY
        : CHAIN_PATTERN.DATA_MOVEMENT;

  return {
    correlationId,
    hops: steps.map((step) => ({
      subjectId: step.subjectId,
      action: step.action,
      at: step.at,
    })),
    pattern,
    severity: pattern === CHAIN_PATTERN.PRIVILEGE_ESCALATION ? 'high' : 'medium',
    // Detection proposes containment; a person confirms it until the detector is measured.
    containmentProposed: true,
  };
}
