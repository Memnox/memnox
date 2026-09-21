import { SURFACE_KIND, type SurfaceKind } from './discovery.constants';

/**
 * Whether a seam actually refuses something, proved by planting a rule and attempting what
 * it forbids, because installed is not governed and nothing here is inferred.
 */
export const PROOF = {
  /** It was asked to refuse and it refused. */
  ENFORCED: 'enforced',
  /** It was asked to refuse and the action went through. The finding that matters. */
  NOT_ENFORCED: 'not-enforced',
  /** Nothing is in place to ask. Not a failure, and not a pass either. */
  ABSENT: 'absent',
  /** In place, and this cannot prove it from here. Said rather than counted as a pass. */
  UNPROVEN: 'unproven',
} as const;

export type ProofState = (typeof PROOF)[keyof typeof PROOF];

export interface SeamProof {
  seam: SurfaceKind;
  state: ProofState;
  /** What was attempted and what came back, in one line. */
  detail: string;
  /** The command that closes it, when there is one. */
  next?: string;
}

/** Seams a laptop can be asked to prove, in the order the report reads best. */
export const PROVABLE_SEAMS: readonly SurfaceKind[] = [
  SURFACE_KIND.MCP,
  SURFACE_KIND.SHELL,
  SURFACE_KIND.GIT,
  SURFACE_KIND.FILESYSTEM,
  SURFACE_KIND.NETWORK,
];

/**
 * Proved against asked. `absent` is not counted either way: a machine with no egress
 * proxy has not failed a test, it has declined to take one, and rolling that into a
 * score would make an uninstalled seam look like a broken one.
 */
export function summarizeProof(proofs: readonly SeamProof[]): {
  enforced: number;
  asked: number;
  failed: number;
} {
  const asked = proofs.filter(
    (proof) => proof.state === PROOF.ENFORCED || proof.state === PROOF.NOT_ENFORCED,
  );
  return {
    enforced: asked.filter((proof) => proof.state === PROOF.ENFORCED).length,
    asked: asked.length,
    failed: asked.filter((proof) => proof.state === PROOF.NOT_ENFORCED).length,
  };
}

/**
 * True when a seam that was asked to refuse did not. Absent and unproven never fail, so a
 * machine without the egress proxy does not turn CI red for it.
 */
export function enforcementFailed(proofs: readonly SeamProof[]): boolean {
  return summarizeProof(proofs).failed > 0;
}

export function describeProof(state: ProofState): string {
  if (state === PROOF.ENFORCED) return 'enforced';
  if (state === PROOF.NOT_ENFORCED) return 'NOT ENFORCED';
  if (state === PROOF.ABSENT) return 'absent';
  return 'unproven';
}
