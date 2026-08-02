import { describe, expect, it } from 'vitest';
import {
  AGENT_KIND,
  AGENT_STATUS,
  DECISION_EFFECT,
  EMPTY_AGENT_STATS,
} from '@memnox/core';
import type { Advisory, AdvisoryContext, AgentIdentity } from '@memnox/core';
import { DecisionMemoryAdvisor } from '../src/decision-memory-advisor';
import {
  DECISION_ENFORCEMENT,
  DECISION_STATUS,
  type DecisionRecord,
} from '../src/decision-record';
import { InMemoryDecisionStore } from '../src/json-file-decision-store';

const AGENT: AgentIdentity = {
  id: 'agent-1',
  name: 'claude-code',
  kind: AGENT_KIND.CLAUDE_CODE,
  status: AGENT_STATUS.ACTIVE,
  tokenHash: 'hash',
  createdAt: new Date().toISOString(),
  stats: { ...EMPTY_AGENT_STATS },
};

const NO_MIGRATION: DecisionRecord = {
  id: 'dec-1',
  title: 'No database migration before Q4',
  statement: 'Do not migrate the database before Q4.',
  owner: 'CTO',
  decidedAt: '2026-03-01T00:00:00.000Z',
  actions: ['database.migrate', 'database.replace'],
  enforcement: DECISION_ENFORCEMENT.BLOCK,
};

describe('DecisionMemoryAdvisor', () => {
  it('escalates an action that conflicts with a recorded decision', async () => {
    const store = new InMemoryDecisionStore();
    await store.save(NO_MIGRATION);
    const advisor = new DecisionMemoryAdvisor(store, ['team-lead']);

    const advisories = await advisor.advise(
      { action: 'database.migrate' },
      { agent: AGENT },
    );
    expect(advisories).toHaveLength(1);
    expect(advisories[0]?.escalateTo).toBe(DECISION_EFFECT.BLOCK);
    expect(advisories[0]?.reason).toContain('No database migration before Q4');
    expect(advisories[0]?.signals).toContain('decision:dec-1');
  });

  it('ignores unrelated actions and superseded or retired decisions', async () => {
    const store = new InMemoryDecisionStore();
    await store.save({
      ...NO_MIGRATION,
      id: 'dec-2',
      status: DECISION_STATUS.SUPERSEDED,
    });
    await store.save({ ...NO_MIGRATION, id: 'dec-4', status: DECISION_STATUS.RETIRED });
    const advisor = new DecisionMemoryAdvisor(store, ['team-lead']);

    expect(
      await advisor.advise({ action: 'repository.read' }, { agent: AGENT }),
    ).toHaveLength(0);
    expect(
      await advisor.advise({ action: 'database.migrate' }, { agent: AGENT }),
    ).toHaveLength(0);
  });

  it('keeps enforcing a decision that is merely due for review', async () => {
    const store = new InMemoryDecisionStore();
    await store.save({
      ...NO_MIGRATION,
      id: 'dec-5',
      reviewAfter: '2020-01-01T00:00:00.000Z',
    });
    const advisor = new DecisionMemoryAdvisor(store, ['team-lead']);
    expect(
      await advisor.advise({ action: 'database.migrate' }, { agent: AGENT }),
    ).toHaveLength(1);
  });

  it('reports warn-level decisions as signal-only advisories', async () => {
    const store = new InMemoryDecisionStore();
    await store.save({
      ...NO_MIGRATION,
      id: 'dec-3',
      enforcement: DECISION_ENFORCEMENT.WARN,
    });
    const advisor = new DecisionMemoryAdvisor(store, ['team-lead']);

    const advisories = await advisor.advise(
      { action: 'database.migrate' },
      { agent: AGENT },
    );
    expect(advisories).toHaveLength(1);
    expect(advisories[0]?.escalateTo).toBeUndefined();
  });
});

describe('project scope', () => {
  const scoped = (projectId?: string): DecisionRecord => ({
    id: 'dec-project',
    title: 'No schema migrations mid-quarter',
    statement: 'Migrations wait for the release window.',
    owner: 'dana',
    decidedAt: '2026-01-01T00:00:00.000Z',
    actions: ['database.migrate'],
    enforcement: DECISION_ENFORCEMENT.BLOCK,
    projectId,
  });

  const adviseFor = async (
    record: DecisionRecord,
    projectId?: string,
  ): Promise<Advisory[]> => {
    const store = new InMemoryDecisionStore();
    await store.save(record);
    return new DecisionMemoryAdvisor(store, ['eng-lead']).advise(
      { action: 'database.migrate', projectId },
      {} as AdvisoryContext,
    );
  };

  it('enforces a scoped decision inside its own project', async () => {
    expect(await adviseFor(scoped('acme-checkout'), 'acme-checkout')).toHaveLength(1);
  });

  it('leaves another project alone', async () => {
    expect(await adviseFor(scoped('acme-checkout'), 'billing-service')).toEqual([]);
  });

  it('leaves an unscoped action alone when the decision names a project', async () => {
    expect(await adviseFor(scoped('acme-checkout'), undefined)).toEqual([]);
  });

  it('keeps an unscoped decision org-wide, as it meant before projects existed', async () => {
    expect(await adviseFor(scoped(undefined), 'billing-service')).toHaveLength(1);
  });
});
