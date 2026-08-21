import { describe, expect, it } from 'vitest';
import { fingerprintRequest } from '../src/token';

const AGENT = 'a7f1c0de-0000-4000-8000-000000000001';

/** Stops an approval being replayed for a request other than the one it was given for. */
describe('fingerprinting a request', () => {
  it('separates a field that carries the separator from the next field', () => {
    const carried = fingerprintRequest({
      agentId: AGENT,
      action: 'deploy|api',
      target: 'prod',
    });
    const shifted = fingerprintRequest({
      agentId: AGENT,
      action: 'deploy',
      target: 'api|prod',
    });
    expect(carried).not.toBe(shifted);
  });

  it('still binds an identical request to an identical fingerprint', () => {
    const identity = { agentId: AGENT, action: 'payment.refund', amount: 120 };
    expect(fingerprintRequest(identity)).toBe(fingerprintRequest({ ...identity }));
  });

  it('tells an absent field from an empty one', () => {
    expect(fingerprintRequest({ agentId: AGENT, action: 'x' })).toBe(
      fingerprintRequest({ agentId: AGENT, action: 'x', target: '' }),
    );
    expect(fingerprintRequest({ agentId: AGENT, action: 'x', amount: 4500 })).not.toBe(
      fingerprintRequest({ agentId: AGENT, action: 'x', amount: 120 }),
    );
  });
});
