import { describe, expect, it } from 'vitest';
import { DECISION_EFFECT, type ActionEvent } from '@memnox/core';
import {
  DECISION_ENFORCEMENT,
  DECISION_MEMORY_ADVISOR,
  DECISION_STATUS,
  InMemoryDecisionStore,
  REVERSIBILITY_COST,
} from '@memnox/memory';
import {
  DecisionMemoryService,
  type RecordDecisionInput,
} from '../src/decision-memory-service';

const VALID: RecordDecisionInput = {
  title: 'No direct production migrations',
  statement: 'Migrations run through the release pipeline.',
  owner: 'platform-team',
  actions: ['database.migrate'],
  environments: ['production'],
};

const auditEvent = (...advisories: string[]): ActionEvent =>
  ({
    id: 'evt_1',
    occurredAt: '2026-07-27T10:00:00.000Z',
    effect: DECISION_EFFECT.REQUIRE_APPROVAL,
    agentName: 'claude-code',
    action: 'database.migrate',
    reason: 'decision memory',
    advisories,
  }) as unknown as ActionEvent;

function service(events: ActionEvent[] = []): DecisionMemoryService {
  return new DecisionMemoryService({
    store: new InMemoryDecisionStore(),
    auditEvents: async () => events,
  });
}

/** The advisor tags an enforcement hit with the decision it came from. */
const violationSignal = (decisionId: string): string =>
  `${DECISION_MEMORY_ADVISOR}:decision:${decisionId}`;

describe('DecisionMemoryService.record', () => {
  it('registers a decision and returns the stored record', async () => {
    const memory = service();

    const outcome = await memory.record(VALID);

    expect(outcome.ok).toBe(true);
    expect(await memory.list()).toHaveLength(1);
  });

  it('defaults an unspecified enforcement to require_approval', async () => {
    const memory = service();

    await memory.record(VALID);

    expect((await memory.list())[0]?.enforcement).toBe(
      DECISION_ENFORCEMENT.REQUIRE_APPROVAL,
    );
  });

  it('falls back to require_approval when the enforcement is unrecognised', async () => {
    const memory = service();

    await memory.record({ ...VALID, enforcement: 'please-allow-everything' });

    expect((await memory.list())[0]?.enforcement).toBe(
      DECISION_ENFORCEMENT.REQUIRE_APPROVAL,
    );
  });

  it('keeps a recognised enforcement', async () => {
    const memory = service();

    await memory.record({ ...VALID, enforcement: DECISION_ENFORCEMENT.BLOCK });

    expect((await memory.list())[0]?.enforcement).toBe(DECISION_ENFORCEMENT.BLOCK);
  });

  it('drops an unrecognised reversibility cost rather than storing it', async () => {
    const memory = service();

    await memory.record({ ...VALID, reversibilityCost: 'catastrophic' });

    expect((await memory.list())[0]?.reversibilityCost).toBeUndefined();
  });

  it('keeps a recognised reversibility cost', async () => {
    const memory = service();

    await memory.record({
      ...VALID,
      reversibilityCost: REVERSIBILITY_COST.HIGH,
    });

    expect((await memory.list())[0]?.reversibilityCost).toBe(REVERSIBILITY_COST.HIGH);
  });

  it('refuses an equivalent active decision instead of duplicating it', async () => {
    const memory = service();
    await memory.record(VALID);

    const outcome = await memory.record(VALID);

    expect(outcome.ok).toBe(false);
    expect(await memory.list()).toHaveLength(1);
  });

  it('reports a missing supersede target rather than orphaning the record', async () => {
    const memory = service();

    const outcome = await memory.record({ ...VALID, supersedes: 'dec_missing' });

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).not.toBe('duplicate');
  });
});

describe('DecisionMemoryService.setStatus / remove', () => {
  it('retires a decision without deleting it', async () => {
    const memory = service();
    const created = await memory.record(VALID);
    const id = created.ok ? created.record.id : '';

    const updated = await memory.setStatus(id, DECISION_STATUS.RETIRED);

    expect(updated?.status).toBe(DECISION_STATUS.RETIRED);
    expect(await memory.list()).toHaveLength(1);
  });

  it('returns null when the decision to update does not exist', async () => {
    expect(await service().setStatus('dec_missing', DECISION_STATUS.RETIRED)).toBeNull();
  });

  it('removes a decision by id', async () => {
    const memory = service();
    const created = await memory.record(VALID);
    const id = created.ok ? created.record.id : '';

    expect(await memory.remove(id)).toBe(true);
    expect(await memory.list()).toEqual([]);
  });

  it('reports false when removing a decision that is not there', async () => {
    expect(await service().remove('dec_missing')).toBe(false);
  });
});

describe('DecisionMemoryService.search', () => {
  it('finds a decision by keyword when no embedding key is configured', async () => {
    const memory = service();
    await memory.record(VALID);

    const hits = await memory.search('migrations');

    expect(hits.length).toBeGreaterThan(0);
  });

  it('returns nothing for a query that matches no decision', async () => {
    const memory = service();
    await memory.record(VALID);

    expect(await memory.search('kubernetes ingress')).toEqual([]);
  });

  it('uses the semantic index when one is configured', async () => {
    const store = new InMemoryDecisionStore();
    const indexed: number[] = [];
    const memory = new DecisionMemoryService({
      store,
      auditEvents: async () => [],
      semanticSearch: {
        index: async (decisions: readonly unknown[]) => {
          indexed.push(decisions.length);
          return decisions.length;
        },
        search: async () => [{ decision: 'stub' }],
      } as never,
    });
    await memory.record(VALID);

    const hits = await memory.search('anything at all');

    expect(indexed).toEqual([1]);
    expect(hits).toHaveLength(1);
  });

  it('searchByKeyword stays deterministic even when a semantic index exists', async () => {
    const memory = new DecisionMemoryService({
      store: new InMemoryDecisionStore(),
      auditEvents: async () => [],
      semanticSearch: {
        index: async () => 0,
        search: async () => {
          throw new Error('semantic search must not be used here');
        },
      } as never,
    });
    await memory.record(VALID);

    await expect(memory.searchByKeyword('migrations')).resolves.toBeDefined();
  });
});

describe('DecisionMemoryService.digest', () => {
  it('renders the active corpus as promptable text', async () => {
    const memory = service();
    await memory.record(VALID);

    expect(await memory.digest()).toContain('No direct production migrations');
  });

  it('still renders when the corpus is empty', async () => {
    expect(typeof (await service().digest())).toBe('string');
  });
});

describe('DecisionMemoryService.health', () => {
  it('counts an enforcement hit against the decision that caused it', async () => {
    const memory = service();
    const created = await memory.record(VALID);
    const id = created.ok ? created.record.id : '';
    const withEvents = new DecisionMemoryService({
      store: {
        list: async () => memory.list(),
        save: async () => {},
        remove: async () => true,
      },
      auditEvents: async () => [
        auditEvent(violationSignal(id)),
        auditEvent(violationSignal(id)),
      ],
    });

    const report = await withEvents.health();

    expect(report.entries.find((entry) => entry.id === id)?.violations).toBe(2);
  });

  it('ignores advisory signals that are not decision enforcement hits', async () => {
    const memory = service();
    const created = await memory.record(VALID);
    const id = created.ok ? created.record.id : '';
    const withEvents = new DecisionMemoryService({
      store: {
        list: async () => memory.list(),
        save: async () => {},
        remove: async () => true,
      },
      auditEvents: async () => [auditEvent('taint', 'blast-radius')],
    });

    const report = await withEvents.health();

    expect(report.entries.find((entry) => entry.id === id)?.violations).toBe(0);
  });

  it('reports a healthy empty corpus rather than failing', async () => {
    const report = await service().health();

    expect(report.activeDecisions).toBe(0);
  });
});
