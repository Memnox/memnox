import { describe, expect, it } from 'vitest';
import { signAgentJwt, verifyAgentJwt } from '../src/agent-jwt';

const CONFIG = { secret: ['jwt', 'unit', 'value'].join('-'), issuer: 'idp.acme' };
const HOUR_S = 3_600;

describe('agent JWT', () => {
  it('round-trips a valid token to the agent ID', () => {
    const token = signAgentJwt('agent-1', CONFIG, HOUR_S);
    expect(verifyAgentJwt(token, CONFIG)).toBe('agent-1');
  });

  it('rejects wrong secrets, wrong issuers, and expired tokens', () => {
    const token = signAgentJwt('agent-1', CONFIG, HOUR_S);
    expect(verifyAgentJwt(token, { ...CONFIG, secret: 'other' })).toBeNull();
    expect(verifyAgentJwt(token, { ...CONFIG, issuer: 'idp.other' })).toBeNull();
    expect(verifyAgentJwt(signAgentJwt('agent-1', CONFIG, -HOUR_S), CONFIG)).toBeNull();
  });

  it('rejects tampered payloads and malformed tokens', () => {
    const token = signAgentJwt('agent-1', CONFIG, HOUR_S);
    const [header, , signature] = token.split('.');
    const forgedPayload = Buffer.from(
      JSON.stringify({ sub: 'agent-2', iss: CONFIG.issuer }),
    ).toString('base64url');
    expect(verifyAgentJwt(`${header}.${forgedPayload}.${signature}`, CONFIG)).toBeNull();
    expect(verifyAgentJwt('not-a-jwt', CONFIG)).toBeNull();
  });
});
