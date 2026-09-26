import { describe, expect, it } from 'vitest';
import { authorityItems, type AuthorityRecord } from '../src/keeper/keep-authority';
import { DRIFT_GROUP, driftNotices } from '../src/keeper/keep-drift';

const BEFORE: AuthorityRecord = {
  agents: { 'claude-code': { gh: { changesAllowed: 0, readsAllowed: 42 } } },
  production: { kubectl: ['staging-eu'] },
};

describe('authority that grew between two passes', () => {
  it('says nothing on the first pass, which only sets the record', () => {
    expect(authorityItems(null, BEFORE)).toEqual([]);
  });

  it('names an agent that can now change a system with nobody asked', () => {
    const after: AuthorityRecord = {
      ...BEFORE,
      agents: { 'claude-code': { gh: { changesAllowed: 5, readsAllowed: 42 } } },
    };
    const [item] = authorityItems(BEFORE, after);
    expect(item?.group).toBe(DRIFT_GROUP.AUTHORITY);
    expect(item?.summary).toContain('claude-code can now change gh with nobody asked');
    expect(driftNotices([item!])[0]).toContain('memnox explain claude-code');
  });

  it('names a CLI newly logged in, and a credential that now names production', () => {
    const after: AuthorityRecord = {
      agents: BEFORE.agents,
      production: { kubectl: ['staging-eu', 'prod-eu-1'], railway: [] },
    };
    const summaries = authorityItems(BEFORE, after).map((each) => each.summary);
    expect(summaries.some((each) => each.startsWith('railway is logged in'))).toBe(true);
    expect(summaries.some((each) => each.includes('now names prod-eu-1'))).toBe(true);
  });

  it('says nothing when authority only narrowed', () => {
    const after: AuthorityRecord = {
      agents: { 'claude-code': { gh: { changesAllowed: 0, readsAllowed: 10 } } },
      production: { kubectl: [] },
    };
    expect(authorityItems(BEFORE, after)).toEqual([]);
  });
});
