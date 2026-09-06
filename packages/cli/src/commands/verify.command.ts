import { readFile } from 'node:fs/promises';
import type { Command } from 'commander';
import { homedir } from 'node:os';
import {
  describeProof,
  enforcementFailed,
  PROOF,
  summarizeProof,
  verifyBundle,
  VERIFY_RESULT,
  type Bundle,
  type SeamProof,
} from '@memnox/core';
import type { CliContext } from '../cli-context';
import { proveEnforcement, type ProbeContext } from '../verify/enforcement';

/**
 * The other half of a signed export. An auditor who cannot check a bundle is looking
 * at a file somebody could have edited, so the checker ships with the thing that
 * signs — and it needs nothing from us, because the key travels with the bundle.
 */
export function registerVerifyCommand(
  program: Command,
  context: CliContext,
  probe: (ctx: ProbeContext) => Promise<SeamProof[]> = proveEnforcement,
  home: () => string = homedir,
  dir: () => string = () => process.cwd(),
): void {
  program
    .command('verify [bundle]')
    .description('Check an exported bundle, or prove the seams actually refuse')
    .option(
      '--enforcement',
      'ask every seam to refuse something, and report what came back',
    )
    .action(async (path: string | undefined, options: { enforcement?: boolean }) => {
      if (options.enforcement === true) {
        await renderEnforcement(context, await probe({ home: home(), dir: dir() }));
        return;
      }
      if (path === undefined) {
        throw new Error(
          'Name a bundle to check, or pass --enforcement to prove the seams refuse.',
        );
      }
      const raw = await readFile(path, 'utf8');
      const split = raw.indexOf('\n\n');
      if (split === -1) {
        throw new Error(`${path} is not a Memnox bundle — no header was found.`);
      }

      let header: Bundle;
      try {
        header = JSON.parse(raw.slice(0, split)) as Bundle;
      } catch {
        throw new Error(`${path} has a header that is not JSON.`);
      }

      /* The file ends with a newline the way every text file does, and it is not part
         of what was signed. Counting it would make every honest bundle read as edited. */
      const body = raw.slice(split + 2).replace(/\n$/, '');
      const check = verifyBundle(header, body);
      const { out, style } = context;

      out.line(
        check.result === VERIFY_RESULT.VALID
          ? style.ok(`VALID    ${check.detail}`)
          : style.warn(`${check.result.toUpperCase().padEnd(9)}${check.detail}`),
      );
      if (header.excluded.length > 0) {
        out.line('');
        out.line('  Left out of this bundle:');
        for (const each of header.excluded) out.line(`    ${each}`);
      }
      if (check.result !== VERIFY_RESULT.VALID) process.exitCode = 1;
    });
}

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
async function renderEnforcement(
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
