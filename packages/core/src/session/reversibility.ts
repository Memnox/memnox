import { TOOL_CLASS, type ToolClass } from '../discovery/classify';

/** Whether Memnox could put this back. An irreversible action is never handed over on habit alone. */
export const REVERSIBILITY = {
  /** A milestone puts it back: the working tree, and what git already versions. */
  SNAPSHOT: 'snapshot',
  /**
   * Undoable only by a second action nobody has recorded. Named rather than folded
   * into snapshot, because this runtime does not record inverse calls and pretending
   * it does is how a rollback promises what it cannot deliver.
   */
  COMPENSABLE: 'compensable',
  /** Gone the moment it happens. An email sent, a message posted, a payment made. */
  IRREVERSIBLE: 'irreversible',
} as const;

export type Reversibility = (typeof REVERSIBILITY)[keyof typeof REVERSIBILITY];

/** Surfaces a milestone covers. Everything else leaves this machine or outlives it. */
const SNAPSHOT_SURFACES: readonly string[] = ['filesystem', 'git'];

/** Verbs a milestone cannot reach, because they changed somebody else's system. */
const IRREVERSIBLE_VERBS: readonly string[] = [
  'send',
  'email',
  'post',
  'publish',
  'notify',
  'message',
  'invite',
  'deploy',
  'release',
  'refund',
  'charge',
  'pay',
  'transfer',
];

export function reversibilityOf(
  action: string,
  toolClass: ToolClass,
  surface?: string,
): Reversibility {
  const segments = action
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  if (IRREVERSIBLE_VERBS.some((verb) => segments.includes(verb))) {
    return REVERSIBILITY.IRREVERSIBLE;
  }
  // The message has been read by the time anybody decides it was a mistake.
  if (toolClass === TOOL_CLASS.COMMUNICATION) return REVERSIBILITY.IRREVERSIBLE;

  if (surface !== undefined && SNAPSHOT_SURFACES.includes(surface)) {
    return REVERSIBILITY.SNAPSHOT;
  }
  // A read changes nothing, so there is nothing to put back.
  if (toolClass === TOOL_CLASS.READ) return REVERSIBILITY.SNAPSHOT;
  return REVERSIBILITY.COMPENSABLE;
}

/** The one rule this exists for: nothing irreversible is ever handed over. */
export function canBeAutomatic(reversibility: Reversibility): boolean {
  return reversibility !== REVERSIBILITY.IRREVERSIBLE;
}

export function describeReversibility(reversibility: Reversibility): string {
  if (reversibility === REVERSIBILITY.SNAPSHOT) return 'a milestone puts this back';
  if (reversibility === REVERSIBILITY.COMPENSABLE) {
    return 'undoing this needs a second action nobody has recorded';
  }
  return 'this cannot be undone';
}
