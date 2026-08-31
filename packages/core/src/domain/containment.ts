export const CONTAINMENT_KIND = {
  /** Revoke leases, close seams, cancel pending steps, quarantine credentials. */
  KILL: 'kill',
  /** Read-only with no capability issuance: debuggable rather than dead. */
  QUARANTINE: 'quarantine',
  /** Organization-wide. Needs a reason, an author and a restore path. */
  PANIC: 'panic',
  RESTORE: 'restore',
} as const;

export type ContainmentKind = (typeof CONTAINMENT_KIND)[keyof typeof CONTAINMENT_KIND];

export interface ContainmentEffects {
  installsReached: number;
  leasesRevoked: number;
  seamsClosed: number;
  stepsCancelled: number;
  environmentsRaised: number;
}

export interface InstallRef {
  id: string;
  hostLabel: string;
  lastSeenAt?: string;
}

export interface ContainmentAction {
  id: string;
  workspaceId: string;
  kind: ContainmentKind;
  subjectId?: string;
  reason: string;
  authorId: string;
  at: string;
  effects: ContainmentEffects;
  /**
   * Stated, never hidden. A killed agent on a laptop that is asleep is not killed yet,
   * and a kill reporting success while one machine is offline is the worst possible lie.
   */
  unreached: InstallRef[];
}

export const EMPTY_CONTAINMENT_EFFECTS: ContainmentEffects = {
  installsReached: 0,
  leasesRevoked: 0,
  seamsClosed: 0,
  stepsCancelled: 0,
  environmentsRaised: 0,
};

/** Complete only when nothing was left unreached; the console shows the gap until it closes. */
export function isContainmentComplete(action: ContainmentAction): boolean {
  return action.unreached.length === 0;
}

/** Panic is organization-wide, so it must not be expressible without a way back. */
export function requiresRestorePath(kind: ContainmentKind): boolean {
  return kind === CONTAINMENT_KIND.PANIC;
}
