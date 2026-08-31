import { describe, expect, it } from 'vitest';
import { DECISION_ENFORCEMENT, DECISION_STATUS } from '../src/decision-record';
import type { DecisionRecord } from '../src/decision-record';
import { searchDecisions } from '../src/decision-search';

function decision(overrides: Partial<DecisionRecord>): DecisionRecord {
  return {
    id: 'dec',
    title: 'Untitled',
    statement: '',
    owner: 'team',
    decidedAt: new Date().toISOString(),
    actions: [],
    enforcement: DECISION_ENFORCEMENT.WITHHOLD,
    ...overrides,
  };
}

const CORPUS: DecisionRecord[] = [
  decision({
    id: 'db',
    title: 'No database migration before Q4',
    statement: 'Do not migrate the database before Q4.',
    actions: ['database.migrate'],
  }),
  decision({
    id: 'deploy',
    title: 'Friday deploy freeze',
    statement: 'No production deploys on Fridays.',
    actions: ['deploy.service'],
  }),
  decision({
    id: 'retired',
    title: 'Old database rule',
    statement: 'database stuff',
    actions: ['database.migrate'],
    status: DECISION_STATUS.RETIRED,
  }),
];

describe('searchDecisions', () => {
  it('ranks title matches above body matches and skips retired decisions', () => {
    const hits = searchDecisions(CORPUS, 'database migration');
    expect(hits[0]?.decision.id).toBe('db');
    expect(hits.map((hit) => hit.decision.id)).not.toContain('retired');
  });

  it('matches action patterns and returns nothing for unrelated queries', () => {
    expect(searchDecisions(CORPUS, 'deploy')[0]?.decision.id).toBe('deploy');
    expect(searchDecisions(CORPUS, 'kubernetes ingress')).toHaveLength(0);
    expect(searchDecisions(CORPUS, '')).toHaveLength(0);
  });
});
