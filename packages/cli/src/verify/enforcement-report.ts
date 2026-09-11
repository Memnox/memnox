import {
  describeProof,
  enforcementFailed,
  PROOF,
  summarizeProof,
  type SeamProof,
} from '@memnox/core';
import type { CliContext } from '../cli-context';

/**
 * Does anything actually refuse?
 *
 * Part of `doctor` rather than a command of its own, because it is the second
 * half of one question. `--wiring` reads the configuration and says whether the
 * seams are installed; this asks each of them to refuse something and reports
 * what came back. Somebody who has just been told they are installed is asking
 * exactly this next.
 */

const SEAM_WIDTH = 12;
const STATE_WIDTH = 14;

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
  const { out, style } = context;
  out.line('');
  out.line(style.bold('DOES ANYTHING ACTUALLY REFUSE'));
  out.line('');

  for (const proof of proofs) {
    const label = describeProof(proof.state);
    const shown =
      proof.state === PROOF.ENFORCED
        ? style.ok(label.padEnd(STATE_WIDTH))
        : proof.state === PROOF.NOT_ENFORCED
          ? style.warn(label.padEnd(STATE_WIDTH))
          : style.dim(label.padEnd(STATE_WIDTH));
    out.line(`  ${proof.seam.padEnd(SEAM_WIDTH)}${shown}${proof.detail}`);
    if (proof.next !== undefined) {
      out.line(`  ${''.padEnd(SEAM_WIDTH + STATE_WIDTH)}${style.dim(`→ ${proof.next}`)}`);
    }
  }

  const { enforced, asked, failed } = summarizeProof(proofs);
  out.line('');
  if (asked === 0) {
    out.line('Nothing was in place to ask, so nothing was proved.');
  } else {
    out.line(
      failed === 0
        ? `${enforced} of ${asked} seam(s) asked to refuse did.`
        : style.warn(
            `${failed} of ${asked} seam(s) were in place and let the action through.`,
          ),
    );
  }
  // Read config; this ran one. Both, because they answer different questions.
  out.note(
    '"memnox doctor --wiring" reads the configuration; this attempted the action.',
  );
  if (enforcementFailed(proofs)) process.exitCode = 1;
}
