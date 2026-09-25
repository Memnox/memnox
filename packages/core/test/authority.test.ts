import { describe, expect, it } from 'vitest';
import { authorityOf, describeTally } from '../src/session/authority';

describe('what an agent may do in each system', () => {
  it('counts reads and changes by the verdict each would meet', () => {
    const [gh] = authorityOf(
      [
        {
          system: 'gh',
          candidates: [
            { action: 'gh.pr-view', class: 'read' },
            { action: 'gh.pr-list', class: 'read' },
            { action: 'gh.pr-merge', class: 'write' },
            { action: 'gh.repo-delete', class: 'destructive' },
            { action: 'gh.unknown', class: 'unknown' },
          ],
        },
      ],
      (candidate) =>
        candidate.class === 'read'
          ? { effect: 'allow', matched: false }
          : candidate.class === 'write'
            ? { effect: 'ask', matched: true }
            : { effect: 'deny', matched: true },
    );
    expect(gh?.reads).toEqual({ allow: 2, ask: 0, deny: 0, unruled: 2 });
    expect(gh?.changes).toEqual({ allow: 0, ask: 1, deny: 1, unruled: 0 });
  });

  it('says a tally in a few words', () => {
    expect(describeTally({ allow: 3, ask: 0, deny: 0, unruled: 0 })).toBe(
      'all 3 allowed',
    );
    expect(describeTally({ allow: 0, ask: 0, deny: 4, unruled: 0 })).toBe(
      'all 4 refused',
    );
    expect(describeTally({ allow: 1, ask: 2, deny: 0, unruled: 1 })).toBe(
      '1 allowed, 2 asked, 1 by no rule',
    );
    expect(describeTally({ allow: 0, ask: 0, deny: 0, unruled: 0 })).toBe('none');
  });
});
