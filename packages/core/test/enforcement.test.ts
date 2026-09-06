import { describe, expect, it } from 'vitest';
import {
  describeProof,
  enforcementFailed,
  PROOF,
  summarizeProof,
  type SeamProof,
} from '../src/discovery/enforcement';

const proof = (state: SeamProof['state'], seam = 'mcp'): SeamProof =>
  ({ seam, state, detail: '' }) as SeamProof;

describe('proving a seam refuses', () => {
  it('counts only the seams that were actually asked', () => {
    const proofs = [
      proof(PROOF.ENFORCED),
      proof(PROOF.NOT_ENFORCED, 'shell'),
      proof(PROOF.ABSENT, 'network'),
      proof(PROOF.UNPROVEN, 'git'),
    ];

    // Two were in place to ask; the other two declined the test rather than failing it.
    expect(summarizeProof(proofs)).toEqual({ enforced: 1, asked: 2, failed: 1 });
  });

  /* A machine that has not installed the egress proxy must not go red for it, or
     people install nothing and turn the check off — at which point it protects nothing. */
  it('does not fail on a seam that is simply not installed', () => {
    expect(enforcementFailed([proof(PROOF.ABSENT), proof(PROOF.UNPROVEN)])).toBe(false);
    expect(summarizeProof([proof(PROOF.ABSENT)])).toEqual({
      enforced: 0,
      asked: 0,
      failed: 0,
    });
  });

  /* The one finding this exists for: it was in place, it was asked, it let it through. */
  it('fails when a seam that was in place did not refuse', () => {
    expect(enforcementFailed([proof(PROOF.ENFORCED), proof(PROOF.NOT_ENFORCED)])).toBe(
      true,
    );
  });

  it('says NOT ENFORCED loudly and everything else plainly', () => {
    expect(describeProof(PROOF.NOT_ENFORCED)).toBe('NOT ENFORCED');
    expect(describeProof(PROOF.ENFORCED)).toBe('enforced');
    expect(describeProof(PROOF.UNPROVEN)).toBe('unproven');
  });
});
