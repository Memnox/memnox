import { describe, expect, it } from 'vitest';
import { STATE_FACT_KIND } from '../src/constants/state-fact.constants';
import {
  STATE_FACT_REFUSAL,
  describeStateFact,
  stateFactCovering,
  stateFactsInForce,
  validateStateFact,
  type StateFact,
} from '../src/domain/state-fact';

const freeze = (over: Partial<StateFact> = {}): StateFact => ({
  id: 'stf_1',
  kind: STATE_FACT_KIND.FREEZE,
  scope: ['production'],
  reason: 'INC-421, payments latency',
  source: '#incident',
  declaredAt: '2026-09-01T09:12:00.000Z',
  validUntil: '2026-09-01T18:00:00.000Z',
  ...over,
});

describe('a state fact carries an expiry', () => {
  it('accepts one that says when it stops', () => {
    expect(validateStateFact(freeze())).toEqual([]);
  });

  it('refuses one with no expiry at all', () => {
    // A freeze that outlives its incident is worse than no freeze: the next one gets
    // ignored, and the one after that is the real emergency.
    expect(validateStateFact(freeze({ validUntil: '' }))).toContain(
      STATE_FACT_REFUSAL.NO_EXPIRY,
    );
  });

  it('refuses one that expires before it starts', () => {
    expect(
      validateStateFact(freeze({ validUntil: '2026-09-01T09:00:00.000Z' })),
    ).toContain(STATE_FACT_REFUSAL.EXPIRES_BEFORE_IT_STARTS);
  });

  it('refuses one covering nothing, and one nobody is named for', () => {
    const refusals = validateStateFact(freeze({ scope: [], source: '' }));
    expect(refusals).toContain(STATE_FACT_REFUSAL.NO_SCOPE);
    expect(refusals).toContain(STATE_FACT_REFUSAL.NO_SOURCE);
  });
});

describe('what is in force right now', () => {
  it('takes the moment as an argument rather than reading a clock', () => {
    const facts = [freeze()];

    expect(stateFactsInForce(facts, '2026-09-01T10:00:00.000Z')).toHaveLength(1);
    expect(stateFactsInForce(facts, '2026-09-02T10:00:00.000Z')).toEqual([]);
  });

  it('never counts an invalid fact as being in force', () => {
    expect(
      stateFactsInForce([freeze({ validUntil: '' })], '2026-09-01T10:00:00.000Z'),
    ).toEqual([]);
  });

  it('finds the fact covering an environment, and none for one it does not', () => {
    const facts = [freeze()];

    expect(stateFactCovering(facts, 'Production', '2026-09-01T10:00:00.000Z')?.id).toBe(
      'stf_1',
    );
    expect(stateFactCovering(facts, 'staging', '2026-09-01T10:00:00.000Z')).toBeNull();
  });

  it('reads back with the reason verbatim and who said so', () => {
    expect(describeStateFact(freeze())).toContain('INC-421, payments latency');
    expect(describeStateFact(freeze())).toContain('#incident');
  });
});
