import {
  describeProof,
  enforcementFailed,
  PROOF,
  summarizeProof,
  type SeamProof,
} from '@memnox/core';
import type { CliContext } from '../cli-context';
import { TONE } from '../flow';

/**
 * Does anything actually refuse?
 *
 * Part of `doctor` rather than a command of its own, because it is the second
 * half of one question. `--wiring` reads the configuration and says whether the
 * seams are installed; this asks each of them to refuse something and reports
 * what came back. Somebody who has just been told they are installed is asking
 * exactly this next.
 */

/** The seam column, so the state beside it lines up down the page. */
const SEAM_WIDTH = 12;

/** What a proof came back as, in the vocabulary the rail draws things in. */
function toneOf(state: SeamProof['state']): (typeof TONE)[keyof typeof TONE] {
  if (state === PROOF.ENFORCED) return TONE.OK;
  if (state === PROOF.NOT_ENFORCED) return TONE.WARN;
  return TONE.DIM;
}

/**
 * What each seam did when it was asked to refuse.
 *
 * `absent` never fails the command: a machine that has not installed the egress proxy
 * has declined the test rather than failed it, and going red for that teaches people
 * to stop running this. Only a seam that was in place and let the action through is
 * a failure, and it is the loudest line on the screen.
 */
export async function renderEnforcement(
  context: CliContext,
  proofs: readonly SeamProof[],
): Promise<void> {
  const { flow, style } = context;

  flow.list(
    'Does anything actually refuse',
    proofs.map((proof) => ({
      tone: toneOf(proof.state),
      text: `${proof.seam.padEnd(SEAM_WIDTH)}${describeProof(proof.state)}  ${proof.detail}`,
      detail: [proof.next === undefined ? undefined : `→ ${proof.next}`],
    })),
  );

  const { enforced, asked, failed } = summarizeProof(proofs);
  if (asked === 0) {
    flow.close('Nothing was in place to ask, so nothing was proved.');
  } else {
    flow.close(
      failed === 0
        ? style.ok(`${enforced} of ${asked} seam(s) asked to refuse did.`)
        : style.warn(
            `${failed} of ${asked} seam(s) were in place and let the action through.`,
          ),
    );
  }
  // Read config; this ran one. Both, because they answer different questions.
  flow.hint(
    '"memnox doctor --wiring" reads the configuration; this attempted the action.',
  );
  if (enforcementFailed(proofs)) process.exitCode = 1;
}
