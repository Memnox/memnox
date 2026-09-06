import { SURFACE_KIND, type SurfaceKind } from './discovery.constants';

/**
 * Whether a seam actually refuses something, proved by asking it to.
 *
 * `doctor --wiring` reads configuration and answers "is this installed". That is a
 * different question, and the gap between the two is where this product fails badly:
 * `mcp wrap` once repointed every server at a proxy that came up with no rules and
 * forwarded everything, while the wiring check reported all servers routed. Routed is
 * not governed, installed is not enforcing, and a readout nobody can trust is worse
 * than no readout — the whole proposition is that you can stop watching the agent.
 *
 * So this plants a rule, attempts the thing the rule forbids, and reports what came
 * back. Nothing here infers: a seam is enforcing because it refused, or it is not.
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
 * Non-zero when a seam that was asked to refuse did not.
 *
 * Absent and unproven never fail the command: a machine that has not installed the
 * egress proxy must not have its CI go red for it, or people install nothing and turn
 * the check off. Only a seam that was in place and let the action through is a failure.
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
