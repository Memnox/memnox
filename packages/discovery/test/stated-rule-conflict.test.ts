import { describe, expect, it } from 'vitest';
import { statedRuleConflicts } from '../src/stated-rule-conflict';
import { EVIDENCE_SOURCE } from '../src/discovery.constants';
import type { RepositoryEvidence } from '../src/repository-evidence';

function evidence(text: string): RepositoryEvidence {
  return {
    root: '/repo',
    stated: [
      {
        id: 'rule-1',
        text,
        source: EVIDENCE_SOURCE.AGENT_INSTRUCTIONS,
        statedIn: 'AGENTS.md',
        line: 12,
      },
    ],
    enforced: [],
    read: ['AGENTS.md'],
  };
}

const AT = '2026-03-01T10:00:00.000Z';

describe('statedRuleConflicts', () => {
  it('surfaces an action that shares the vocabulary of a stated rule', () => {
    const found = statedRuleConflicts(
      evidence('Services must use the repository layer, never direct database access.'),
      [{ agentId: 'claude-code', action: 'database.access', target: 'services', at: AT }],
    );
    expect(found).toHaveLength(1);
    expect(found[0]?.matchedOn).toContain('database');
    expect(found[0]?.rule.statedIn).toBe('AGENTS.md');
  });

  it('always reports enforced false, because a document never refused anything', () => {
    const found = statedRuleConflicts(
      evidence('Services must use the repository layer, never direct database access.'),
      [{ agentId: 'claude-code', action: 'database.access', target: 'services', at: AT }],
    );
    expect(found[0]?.enforced).toBe(false);
  });

  it('stays quiet on a single shared word, which would match almost everything', () => {
    const found = statedRuleConflicts(evidence('Never deploy on a Friday afternoon.'), [
      { agentId: 'claude-code', action: 'repository.read', at: AT },
    ]);
    expect(found).toEqual([]);
  });

  it('ignores the normative words themselves, which every rule contains', () => {
    const found = statedRuleConflicts(evidence('You must never do this.'), [
      { agentId: 'claude-code', action: 'must.never', at: AT },
    ]);
    expect(found).toEqual([]);
  });

  it('is empty when the repository states nothing', () => {
    const nothing: RepositoryEvidence = {
      root: '/repo',
      stated: [],
      enforced: [],
      read: [],
    };
    expect(
      statedRuleConflicts(nothing, [
        { agentId: 'claude-code', action: 'database.delete', at: AT },
      ]),
    ).toEqual([]);
  });
});
