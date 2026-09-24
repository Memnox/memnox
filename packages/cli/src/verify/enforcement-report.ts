import {
  describeProof,
  enforcementFailed,
  EXIT,
  PROOF,
  summarizeProof,
  type SeamProof,
} from '@memnox/core';
import type { CliContext } from '../cli-context';
import { TONE } from '../flow';

/** What `doctor --prove` found when it asked each seam to refuse something. */

/** The seam column, so the state beside it lines up down the page. */
const SEAM_WIDTH = 12;

/** What a proof came back as, in the vocabulary the rail draws things in. */
function toneOf(state: SeamProof['state']): (typeof TONE)[keyof typeof TONE] {
  if (state === PROOF.ENFORCED) return TONE.OK;
  if (state === PROOF.NOT_ENFORCED) return TONE.WARN;
  return TONE.DIM;
}

/**
 * What each seam did when asked to refuse, and the exit code for the caller to set:
 * only a seam in place that let the action through fails, never an absent one.
 */
export function renderEnforcement(
  context: CliContext,
  proofs: readonly SeamProof[],
): number {
  const { flow } = context;
  flow.list(
    'Does anything actually refuse',
    proofs.map((proof) => ({
      tone: toneOf(proof.state),
      text: `${proof.seam.padEnd(SEAM_WIDTH)}${describeProof(proof.state)}  ${proof.detail}`,
      detail: [proof.next === undefined ? undefined : `→ ${proof.next}`],
    })),
  );
  flow.close(describeVerdict(context, proofs));
  // Both, because reading the configuration and attempting the action answer different questions.
  flow.hint(
    '"memnox doctor --wiring" reads the configuration; this attempted the action.',
  );
  return enforcementFailed(proofs) ? EXIT.FAILED : EXIT.OK;
}

function describeVerdict(context: CliContext, proofs: readonly SeamProof[]): string {
  const { style } = context;
  const { enforced, asked, failed } = summarizeProof(proofs);
  if (asked === 0) return 'Nothing was in place to ask, so nothing was proved.';
  if (failed === 0)
    return style.ok(`${enforced} of ${asked} seam(s) asked to refuse did.`);
  return style.warn(
    `${failed} of ${asked} seam(s) were in place and let the action through.`,
  );
}
