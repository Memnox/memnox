import { describe, expect, it } from 'vitest';
import { ACTOR_KIND, isActorKind } from '@memnox/core';
import { assembleLineage, type HopObservation } from '../src/index';
import { LINEAGE_METHOD } from '../src/ledger.constants';

const SESSION = 'session-1';

function hop(overrides: Partial<HopObservation> = {}): HopObservation {
  return {
    at: '2026-03-01T10:00:00.000Z',
    actorId: 'moise',
    actorKind: ACTOR_KIND.HUMAN,
    system: 'deploy.service',
    correlationId: SESSION,
    method: LINEAGE_METHOD.PROPAGATED,
    ...overrides,
  };
}

describe('normalized actors', () => {
  it('names the five kinds, so a person is never mistaken for a pipeline', () => {
    expect(Object.values(ACTOR_KIND)).toEqual([
      'human',
      'ai-agent',
      'ci',
      'automation',
      'service',
    ]);
  });

  it('refuses a label nobody defined, which is what keeps the set closed', () => {
    expect(isActorKind('agent')).toBe(false);
    expect(isActorKind(ACTOR_KIND.AI_AGENT)).toBe(true);
  });

  it('carries each hop kind through, so a chain reads person then agent', () => {
    const lineage = assembleLineage(SESSION, [
      hop(),
      hop({
        at: '2026-03-01T10:00:05.000Z',
        actorId: 'claude-code',
        actorKind: ACTOR_KIND.AI_AGENT,
      }),
      hop({
        at: '2026-03-01T10:00:09.000Z',
        actorId: 'shell-seam',
        actorKind: ACTOR_KIND.AUTOMATION,
        method: LINEAGE_METHOD.INFERRED,
      }),
    ]);

    expect(lineage.hops.map((each) => each.actorKind)).toEqual([
      ACTOR_KIND.HUMAN,
      ACTOR_KIND.AI_AGENT,
      ACTOR_KIND.AUTOMATION,
    ]);
  });

  it('keeps an inferred hop marked as inferred rather than promoting it', () => {
    const lineage = assembleLineage(SESSION, [
      hop({ actorKind: ACTOR_KIND.CI, method: LINEAGE_METHOD.INFERRED }),
    ]);
    expect(lineage.hops[0]?.method).toBe(LINEAGE_METHOD.INFERRED);
  });
});
