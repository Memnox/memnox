/**
 * A small ladder, not a score. A scalar that silently widens permission is unauditable
 * and impossible to explain to a regulator; a level is a named bundle of rules —
 * readable, testable, diffable, revocable, and granted by a person.
 */
export const AUTONOMY_LEVEL = {
  OBSERVE: 0,
  SUGGEST: 1,
  ACT_REVERSIBLY: 2,
  ACT_WITHIN_BOUNDS: 3,
  ACT_AUTONOMOUSLY: 4,
  HOLD_DELEGATED_AUTHORITY: 5,
} as const;

export type AutonomyLevelKey = (typeof AUTONOMY_LEVEL)[keyof typeof AUTONOMY_LEVEL];

export const AUTONOMY_LEVEL_NAME: Record<AutonomyLevelKey, string> = {
  [AUTONOMY_LEVEL.OBSERVE]: 'observe',
  [AUTONOMY_LEVEL.SUGGEST]: 'suggest',
  [AUTONOMY_LEVEL.ACT_REVERSIBLY]: 'act reversibly',
  [AUTONOMY_LEVEL.ACT_WITHIN_BOUNDS]: 'act within bounds',
  [AUTONOMY_LEVEL.ACT_AUTONOMOUSLY]: 'act autonomously',
  [AUTONOMY_LEVEL.HOLD_DELEGATED_AUTHORITY]: 'hold delegated authority',
};

/** Every item resolves against something already stored. Nobody can tick one. */
export const READINESS_ITEM = {
  OWNER: 'owner',
  POLICY_COVERAGE: 'policy_coverage',
  SEAM_COVERAGE: 'seam_coverage',
  INSTALL_COVERAGE: 'install_coverage',
  BROKERED_CREDENTIALS: 'brokered_credentials',
  ROLLBACK: 'rollback',
  BUDGET: 'budget',
  ESCALATION_PATH: 'escalation_path',
  AUDIT: 'audit',
  TESTS: 'tests',
} as const;

export type ReadinessItemKey = (typeof READINESS_ITEM)[keyof typeof READINESS_ITEM];

export const READINESS_STATUS = {
  MET: 'met',
  UNMET: 'unmet',
  /** The store that would answer this does not exist yet. Not a pass. */
  UNKNOWN: 'unknown',
} as const;

export type ReadinessStatus = (typeof READINESS_STATUS)[keyof typeof READINESS_STATUS];

export const LEVEL_DIRECTION = {
  PROMOTE: 'promote',
  DEMOTE: 'demote',
} as const;

export type LevelDirection = (typeof LEVEL_DIRECTION)[keyof typeof LEVEL_DIRECTION];

export const LEVEL_CAUSE = {
  PROPOSAL: 'proposal',
  INCIDENT: 'incident',
  EXPIRY: 'expiry',
} as const;

export type LevelCause = (typeof LEVEL_CAUSE)[keyof typeof LEVEL_CAUSE];

export const DETECTOR_KIND = {
  STALLED_HANDOFF: 'stalled_handoff',
  DUPLICATE_EFFORT: 'duplicate_effort',
  ORPHANED_OWNERSHIP: 'orphaned_ownership',
  BEHAVIOUR_SHIFT: 'behaviour_shift',
} as const;

export type DetectorKind = (typeof DETECTOR_KIND)[keyof typeof DETECTOR_KIND];

/** Support and agreement both clear a bar, and one dissent resets it. */
export const SYNTHESIS_MIN_SUPPORT = 5;
export const SYNTHESIS_MIN_AGREEMENT = 1;
