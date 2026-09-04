import { describe, expect, it } from 'vitest';
import {
  stateLabelsOf,
  stateVersionOf,
  STATE_FACT_KIND,
  STATE_VERSION_NONE,
  type StateFact,
} from '../src/index';

const AT = '2026-03-01T12:00:00.000Z';

function fact(overrides: Partial<StateFact> = {}): StateFact {
  return {
    id: 'fact-1',
    kind: STATE_FACT_KIND.FREEZE,
    scope: ['production'],
    reason: 'incident 421 is open',
    source: 'platform on-call',
    declaredAt: '2026-03-01T09:00:00.000Z',
    validUntil: '2026-03-01T18:00:00.000Z',
    ...overrides,
  };
}

describe('stateLabelsOf', () => {
  it('offers the kind and the kind:scope pair, so a rule can name either', () => {
    expect(stateLabelsOf([fact()], AT)).toEqual(['freeze', 'freeze:production']);
  });

  it('lowercases the scope, because a rule cannot know how it was typed', () => {
    expect(stateLabelsOf([fact({ scope: ['Production'] })], AT)).toContain(
      'freeze:production',
    );
  });

  it('drops a lapsed fact, so a freeze stops binding the moment it expires', () => {
    const lapsed = fact({ validUntil: '2026-03-01T10:00:00.000Z' });
    expect(stateLabelsOf([lapsed], AT)).toEqual([]);
  });

  it('drops a fact carrying no expiry rather than treating it as permanent', () => {
    const forever = fact({ validUntil: '' });
    expect(stateLabelsOf([forever], AT)).toEqual([]);
  });
});

describe('stateVersionOf', () => {
  it('is "none" when nothing is in force, so the field is always readable', () => {
    expect(stateVersionOf([], AT)).toBe(STATE_VERSION_NONE);
  });

  it('is stable for the same facts, so an unchanged bundle reads as unchanged', () => {
    expect(stateVersionOf([fact()], AT)).toBe(stateVersionOf([fact()], AT));
  });

  it('changes when a fact is added, which is how propagation becomes visible', () => {
    const one = stateVersionOf([fact()], AT);
    const two = stateVersionOf([fact(), fact({ id: 'fact-2' })], AT);
    expect(two).not.toBe(one);
  });

  it('ignores order, because two machines may store the same facts differently', () => {
    const a = fact();
    const b = fact({ id: 'fact-2' });
    expect(stateVersionOf([a, b], AT)).toBe(stateVersionOf([b, a], AT));
  });
});
