import { describe, expect, it } from 'vitest';
import {
  BREAKER_SIGNAL,
  CircuitBreaker,
  DEFAULT_THRESHOLDS,
} from '../src/session/breaker';

describe('drift reported on its own', () => {
  it('trips the breaker at the threshold and touches nothing else', () => {
    const breaker = new CircuitBreaker();
    let breach = null;
    for (let count = 0; count < DEFAULT_THRESHOLDS.scopeDrift; count += 1) {
      breach = breaker.observeDrift('ses_1');
    }
    expect(breach?.signal).toBe(BREAKER_SIGNAL.SCOPE_DRIFT);
    expect(breaker.observeDrift('ses_2')).toBeNull();
  });
});
