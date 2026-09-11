import { describe, expect, it } from 'vitest';
import { PROOF, type SeamProof } from '@memnox/core';
import { registerDoctorCommand } from '../src/commands/doctor.command';
import { runCommand } from './cli-harness';

const proofs = (...states: SeamProof['state'][]): SeamProof[] =>
  states.map(
    (state, at) =>
      ({
        seam: ['mcp', 'shell', 'git'][at] ?? 'mcp',
        state,
        detail: 'probed',
      }) as SeamProof,
  );

/* The probe is the only seam this needs; doctor's other readers never run on
   the --prove path, so they stay at their defaults. */
async function verify(given: SeamProof[]) {
  return runCommand(
    (program, context) =>
      registerDoctorCommand(
        program,
        context,
        undefined,
        () => '/work',
        undefined,
        undefined,
        async () => given,
      ),
    ['doctor', '--prove'],
  );
}

describe('memnox doctor --prove', () => {
  it('reports a seam that let the action through, and exits non-zero', async () => {
    const before = process.exitCode;
    const { out } = await verify(proofs(PROOF.NOT_ENFORCED));

    expect(out.text).toContain('NOT ENFORCED');
    expect(out.text).toContain('1 of 1 seam(s) were in place and let the action through');
    expect(process.exitCode).toBe(1);
    process.exitCode = before;
  });

  it('passes when every seam that was asked refused', async () => {
    const { out } = await verify(proofs(PROOF.ENFORCED, PROOF.ENFORCED));

    expect(out.text).toContain('2 of 2 seam(s) asked to refuse did.');
    expect(out.text).not.toContain('NOT ENFORCED');
  });

  /* Nothing installed is not a failure. Going red for it teaches people to stop
     running the check, and a check nobody runs proves nothing at all. */
  it('says nothing was proved when nothing was in place, and does not fail', async () => {
    const before = process.exitCode;
    const { out } = await verify(proofs(PROOF.ABSENT, PROOF.ABSENT));

    expect(out.text).toContain('Nothing was in place to ask, so nothing was proved.');
    expect(process.exitCode).toBe(before);
  });

  it('says which question it answered, because doctor answers a different one', async () => {
    const { out } = await verify(proofs(PROOF.ENFORCED));

    expect(out.notes.join('\n')).toContain('this attempted the action');
  });
});
