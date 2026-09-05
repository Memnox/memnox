import { describe, expect, it } from 'vitest';
import { CLAIM_KIND, CLAIM_VERDICT, checkClaims, claimsIn } from '../src/ledger/claims';
import type { MemnoxEvent } from '../src/event/event';

function event(over: Partial<MemnoxEvent>): MemnoxEvent {
  return {
    id: 'evt_1',
    schemaVersion: 1,
    at: '2026-09-05T10:00:00.000Z',
    sessionId: 'ses_1',
    agent: 'claude-code',
    actorType: 'agent',
    surface: 'shell',
    operation: 'shell.execute',
    class: 'read',
    effect: 'allow',
    mode: 'enforce',
    reason: 'ok',
    ...over,
  };
}

describe('finding a claim in what an agent said', () => {
  it.each([
    ['All tests pass now.', CLAIM_KIND.TESTS_PASSED],
    ['The suite is green.', CLAIM_KIND.TESTS_PASSED],
    ['I deployed it to staging.', CLAIM_KIND.DEPLOYED],
    ['Committed the fix.', CLAIM_KIND.COMMITTED],
    ['Pushed the branch up.', CLAIM_KIND.PUSHED],
    ['Merged the PR.', CLAIM_KIND.MERGED],
    ['Created a pull request for you.', CLAIM_KIND.CREATED],
  ])('reads "%s" as %s', (text, kind) => {
    expect(claimsIn(text).map((claim) => claim.kind)).toContain(kind);
  });

  it('finds nothing in ordinary prose, so the report is not noise', () => {
    expect(claimsIn('I looked at the file and it seems fine.')).toEqual([]);
  });

  it('keeps the sentence, so a person can judge the match themselves', () => {
    expect(claimsIn('  All tests pass.  ')[0]?.said).toBe('All tests pass.');
  });
});

describe('checking a claim against the ledger', () => {
  it('supports a claim the record can account for', () => {
    const [checked] = checkClaims('All tests pass.', [
      event({ operation: 'shell.execute', exitCode: 0 }),
    ]);
    expect(checked?.verdict).toBe(CLAIM_VERDICT.SUPPORTED);
    expect(checked?.evidence).toEqual(['evt_1']);
  });

  it('contradicts a claim when the thing it names actually failed', () => {
    const [checked] = checkClaims('All tests pass.', [
      event({ operation: 'shell.execute', exitCode: 1, execution: 'failed' }),
    ]);
    expect(checked?.verdict).toBe(CLAIM_VERDICT.CONTRADICTED);
    expect(checked?.because).toContain('exit 1');
  });

  it('calls it unsupported rather than a lie when nothing was recorded', () => {
    const [checked] = checkClaims('I deployed it.', []);
    expect(checked?.verdict).toBe(CLAIM_VERDICT.UNSUPPORTED);
    expect(checked?.evidence).toEqual([]);
    // The wording matters: a gap in the ledger is not evidence of a lie.
    expect(checked?.because).toContain('nothing here recorded');
  });

  it('stays supported when one run failed and a later one did not', () => {
    const [checked] = checkClaims('All tests pass.', [
      event({ id: 'a', operation: 'shell.execute', exitCode: 1 }),
      event({ id: 'b', operation: 'shell.execute', exitCode: 0 }),
    ]);
    expect(checked?.verdict).toBe(CLAIM_VERDICT.SUPPORTED);
  });

  it('matches a deploy claim only against a deploy', () => {
    const [checked] = checkClaims('Deployed to production.', [
      event({ operation: 'git.commit' }),
    ]);
    expect(checked?.verdict).toBe(CLAIM_VERDICT.UNSUPPORTED);
  });

  it('consults no model — the same text and events always give the same answer', () => {
    const events = [event({ operation: 'git.push' })];
    expect(checkClaims('Pushed it.', events)).toEqual(checkClaims('Pushed it.', events));
  });
});
