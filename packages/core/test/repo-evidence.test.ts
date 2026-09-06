import { describe, expect, it } from 'vitest';
import {
  codeownersFor,
  describeEvidence,
  EVIDENCE_TTL_MINUTES,
  isFresh,
  readProtection,
  readPullRequest,
  type RepoEvidence,
} from '../src/discovery/repo-evidence';

const AT = '2026-09-05T10:00:00.000Z';

describe('branch protection read through gh', () => {
  it('reads the required review count', () => {
    const evidence = readProtection(
      '{"required_pull_request_reviews":{"required_approving_review_count":2}}',
      'gh api',
      AT,
    );
    expect(evidence?.requiredReviews).toBe(2);
    expect(describeEvidence(evidence as never)[0]).toContain('2 required review(s)');
  });

  it('says protected without a count rather than reporting zero', () => {
    const evidence = readProtection('{"url":"..."}', 'gh api', AT);
    expect(evidence?.protected).toBe(true);
    // Reporting "0 required reviews" about a branch we could not read would be the lie.
    expect(evidence?.requiredReviews).toBeUndefined();
    expect(describeEvidence(evidence as never)[0]).toBe(
      'branch protection is on (gh api)',
    );
  });

  it('is null when gh printed an error instead of JSON', () => {
    expect(readProtection('Branch not protected', 'gh api', AT)).toBeNull();
  });

  it('says where it came from and when, because cached evidence must say so', () => {
    const evidence = readProtection('{}', 'gh api, just now', AT);
    expect(evidence?.source).toBe('gh api, just now');
    expect(evidence?.fetchedAt).toBe(AT);
  });

  it('goes stale, so a freeze that lifted is not quoted an hour later', () => {
    const evidence = readProtection('{}', 'gh api', AT) as never;
    expect(isFresh(evidence, new Date('2026-09-05T10:05:00.000Z'))).toBe(true);
    expect(isFresh(evidence, new Date('2026-09-05T11:00:00.000Z'))).toBe(false);
    expect(EVIDENCE_TTL_MINUTES).toBe(10);
  });
});

describe('CODEOWNERS', () => {
  const file = [
    '# owners',
    '/src/payments/**   @platform @security',
    '/docs/*            @writers',
    '*                  @everyone',
  ].join('\n');

  it('finds the entry covering a path', () => {
    expect(codeownersFor(file, 'src/payments/charge.ts')).toContain('@platform');
    expect(codeownersFor(file, 'docs/readme.md')).toContain('@writers');
  });

  it('falls back to a catch-all when one is written', () => {
    expect(codeownersFor(file, 'anything/else.ts')).toContain('@everyone');
  });

  it('ignores comments and blank lines', () => {
    expect(codeownersFor('# nothing here\n\n', 'src/x.ts')).toBeNull();
  });
});

describe('what the forge says about the change itself', () => {
  const AT = '2026-09-06T10:00:00.000Z';
  const read = (raw: string) => readPullRequest(raw, 'gh pr view', AT);

  it('reports an open, unapproved pull request, which is what most refusals are about', () => {
    const evidence = read(
      JSON.stringify({ number: 1821, reviewDecision: 'REVIEW_REQUIRED' }),
    );

    expect(evidence?.pullRequest).toEqual({ number: 1821, decision: 'pending' });
    expect(describeEvidence(evidence as RepoEvidence)).toContain(
      'pull request #1821: open and not approved (gh pr view)',
    );
  });

  it('reports an approval, and changes requested, as what they are', () => {
    expect(
      read(JSON.stringify({ number: 1, reviewDecision: 'APPROVED' }))?.pullRequest,
    ).toEqual({ number: 1, decision: 'approved' });
    expect(
      read(JSON.stringify({ number: 2, reviewDecision: 'CHANGES_REQUESTED' }))
        ?.pullRequest,
    ).toEqual({ number: 2, decision: 'changes-requested' });
  });

  /* Unknown is not "not approved". Saying a change is unapproved because the reviews
     could not be read is the reassurance-in-reverse this file exists to refuse. */
  it('says nothing about a decision the forge did not report', () => {
    const evidence = read(JSON.stringify({ number: 7 }));

    expect(evidence?.pullRequest?.decision).toBeUndefined();
    expect(describeEvidence(evidence as RepoEvidence)).toContain(
      'pull request #7: no review decision reported (gh pr view)',
    );
  });

  it('counts checks as passing only when every one of them has', () => {
    const green = read(
      JSON.stringify({
        number: 1,
        statusCheckRollup: [{ conclusion: 'SUCCESS' }, { conclusion: 'SUCCESS' }],
      }),
    );
    // Still running is not passing: calling it passing waves through a build that fails.
    const running = read(
      JSON.stringify({
        number: 1,
        statusCheckRollup: [{ conclusion: 'SUCCESS' }, { conclusion: null }],
      }),
    );

    expect(green?.pullRequest?.checksPassing).toBe(true);
    expect(running?.pullRequest?.checksPassing).toBe(false);
    expect(
      read(JSON.stringify({ number: 1 }))?.pullRequest?.checksPassing,
    ).toBeUndefined();
  });

  it('is absent when there is no pull request, or gh printed something else', () => {
    expect(read('no pull requests found')).toBeNull();
    expect(read(JSON.stringify({}))).toBeNull();
  });
});
