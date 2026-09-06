import { describe, expect, it } from 'vitest';
import { DECISION_EFFECT } from '../src/constants/decision.constants';
import { refusalShapeFor, RETRYABILITY } from '../src/domain/refusal';

describe('what a refusal says about trying again', () => {
  /* The doc's own diagnosis: an agent retries a policy decision forty times because
     the refusal read like a transient failure. The cheapest fix is the refusal. */
  it('tells a model a rule will never yield, so it stops instead of looping', () => {
    const shape = refusalShapeFor(DECISION_EFFECT.DENY, 'main is shared');

    expect(shape.retryability).toBe(RETRYABILITY.NEVER);
    expect(shape.guidance).toContain('Retrying will fail identically');
  });

  it('tells it a freeze or a budget will lift, so it does not abandon the task', () => {
    for (const reason of [
      'production is frozen until Monday',
      'the daily budget is exhausted',
      'src/billing is held by another session',
    ]) {
      const shape = refusalShapeFor(DECISION_EFFECT.DENY, reason);
      expect(shape.retryability).toBe(RETRYABILITY.LATER);
      expect(shape.guidance).toContain('temporary condition');
    }
  });

  it('tells it an ask is waiting on a person, not failing', () => {
    const shape = refusalShapeFor(DECISION_EFFECT.ASK, 'a person decides');

    expect(shape.retryability).toBe(RETRYABILITY.ON_APPROVAL);
    expect(shape.guidance).toContain('Do not retry');
  });
});
