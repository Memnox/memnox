import { describe, expect, it } from 'vitest';
import { ORG_DECISION, decideFrom, isHeld } from '../src/index';

const facts = (
  over: Partial<Parameters<typeof decideFrom>[0]> = {},
): Parameters<typeof decideFrom>[0] => ({
  effect: 'allow',
  hasApprovers: false,
  reliesOnWithheldFacts: false,
  unanswerable: false,
  ...over,
});

describe('decideFrom', () => {
  it('allows what the gate allowed', () => {
    expect(decideFrom(facts())).toBe(ORG_DECISION.ALLOW);
  });

  it('denies what the gate withheld', () => {
    expect(decideFrom(facts({ effect: 'withhold' }))).toBe(ORG_DECISION.DENY);
  });

  it('asks when approval is needed and nobody is named', () => {
    expect(decideFrom(facts({ effect: 'escalate' }))).toBe(ORG_DECISION.ASK);
  });

  it('escalates when approval is needed and somebody is named', () => {
    expect(decideFrom(facts({ effect: 'escalate', hasApprovers: true }))).toBe(
      ORG_DECISION.ESCALATE,
    );
  });

  it('delegates an allowed action that relies on facts the caller may not read', () => {
    expect(decideFrom(facts({ reliesOnWithheldFacts: true }))).toBe(
      ORG_DECISION.DELEGATE,
    );
  });

  it('clarifies an allowed action that cites facts nobody holds', () => {
    expect(decideFrom(facts({ unanswerable: true }))).toBe(ORG_DECISION.CLARIFY);
  });

  it('never widens a refusal, whatever else is true', () => {
    const verdict = decideFrom(
      facts({ effect: 'withhold', reliesOnWithheldFacts: true, unanswerable: true }),
    );

    expect(verdict).toBe(ORG_DECISION.DENY);
  });

  it('keeps approval ahead of delegation — a hold is a hold', () => {
    const verdict = decideFrom(
      facts({ effect: 'escalate', hasApprovers: true, unanswerable: true }),
    );

    expect(verdict).toBe(ORG_DECISION.ESCALATE);
  });
});

describe('isHeld', () => {
  it('holds on every answer but allow', () => {
    expect(isHeld(ORG_DECISION.ALLOW)).toBe(false);
    for (const decision of [
      ORG_DECISION.DENY,
      ORG_DECISION.ASK,
      ORG_DECISION.ESCALATE,
      ORG_DECISION.DELEGATE,
      ORG_DECISION.CLARIFY,
    ]) {
      expect(isHeld(decision)).toBe(true);
    }
  });
});
