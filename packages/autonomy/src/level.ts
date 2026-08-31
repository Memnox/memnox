import {
  AUTONOMY_LEVEL_NAME,
  LEVEL_CAUSE,
  LEVEL_DIRECTION,
  READINESS_STATUS,
  type AutonomyLevelKey,
  type LevelCause,
  type LevelDirection,
  type ReadinessItemKey,
  type ReadinessStatus,
} from './autonomy.constants';

/** What the level actually means, as a bundle of rules rather than a number in a field. */
export interface AutonomyLevel {
  key: AutonomyLevelKey;
  name: string;
  policyPackId: string;
  requires: ReadinessItemKey[];
}

export interface ReadinessItem {
  key: ReadinessItemKey;
  /** Evaluated against a store, never asserted by a person. */
  query: string;
  status: ReadinessStatus;
  blocker?: string;
  remediation?: string;
}

export interface Readiness {
  subjectId: string;
  level: AutonomyLevelKey;
  items: ReadinessItem[];
  /** True only when every required item is met. Unknown is not a pass. */
  ready: boolean;
}

export interface LevelChange {
  subjectId: string;
  from: AutonomyLevelKey;
  to: AutonomyLevelKey;
  direction: LevelDirection;
  cause: LevelCause;
  proposalId?: string;
  incidentId?: string;
  /** Absent only on a demotion, which needs no person. */
  decidedBy?: string;
  at: string;
}

export function levelName(key: AutonomyLevelKey): string {
  return AUTONOMY_LEVEL_NAME[key];
}

/** Unknown is not met: a checklist over a store that does not exist is a questionnaire. */
export function assessReadiness(
  subjectId: string,
  level: AutonomyLevel,
  items: readonly ReadinessItem[],
): Readiness {
  const required = items.filter((item) => level.requires.includes(item.key));
  const missing = level.requires.filter(
    (key) => !required.some((item) => item.key === key),
  );
  const unknowns: ReadinessItem[] = missing.map((key) => ({
    key,
    query: `unresolved: ${key}`,
    status: READINESS_STATUS.UNKNOWN,
    blocker: 'nothing answers this yet',
  }));
  const all = [...required, ...unknowns];
  return {
    subjectId,
    level: level.key,
    items: all,
    ready: all.every((item) => item.status === READINESS_STATUS.MET),
  };
}

/** It names the blockers and the change that closes each. */
export function blockers(readiness: Readiness): ReadinessItem[] {
  return readiness.items.filter((item) => item.status !== READINESS_STATUS.MET);
}

export const PROMOTION_REFUSAL = {
  NOT_READY: 'readiness is not met, and a checklist nobody can tick is the point',
  NO_PERSON: 'nothing promotes without a person',
} as const;

export type PromotionOutcome =
  { promoted: true; change: LevelChange } | { promoted: false; reason: string };

/**
 * Down is automatic, up is not. Trust never widens authority on its own: it is evidence
 * in front of a person, and the moment it becomes an automatic grant the product has
 * removed the accountable human it sells.
 */
export function promote(
  subjectId: string,
  from: AutonomyLevelKey,
  to: AutonomyLevelKey,
  readiness: Readiness,
  decidedBy: string | undefined,
  at: string,
  proposalId?: string,
): PromotionOutcome {
  if (!readiness.ready) return { promoted: false, reason: PROMOTION_REFUSAL.NOT_READY };
  if (decidedBy === undefined || decidedBy.length === 0) {
    return { promoted: false, reason: PROMOTION_REFUSAL.NO_PERSON };
  }
  return {
    promoted: true,
    change: {
      subjectId,
      from,
      to,
      direction: LEVEL_DIRECTION.PROMOTE,
      cause: LEVEL_CAUSE.PROPOSAL,
      decidedBy,
      at,
      ...(proposalId === undefined ? {} : { proposalId }),
    },
  };
}

/** An incident demotes without waiting for anybody; the way back is the proposal path. */
export function demote(
  subjectId: string,
  from: AutonomyLevelKey,
  to: AutonomyLevelKey,
  incidentId: string,
  at: string,
): LevelChange {
  return {
    subjectId,
    from,
    to,
    direction: LEVEL_DIRECTION.DEMOTE,
    cause: LEVEL_CAUSE.INCIDENT,
    incidentId,
    at,
  };
}
