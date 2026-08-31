import { describe, expect, it } from 'vitest';
import {
  AGENT_KIND,
  AGENT_STATUS,
  DECISION_EFFECT,
  type ActionRequest,
  type AgentIdentity,
} from '@memnox/core';
import { EgressAdvisor, RISK_SIGNAL_CREDENTIAL_EGRESS } from '../src/egress-advisor';

const AWS_KEY = ['AKIA', 'IOSFODNN7EXAMPLE'].join('');

const agent: AgentIdentity = {
  id: 'agt_1',
  name: 'claude-code',
  kind: AGENT_KIND.CLAUDE_CODE,
  status: AGENT_STATUS.ACTIVE,
  tokenHash: 'hash',
  capabilities: [],
  createdAt: '2026-01-01T00:00:00.000Z',
  stats: { allowed: 0, withheld: 0, approvalsRequested: 0 },
};

const advise = (request: ActionRequest) =>
  new EgressAdvisor(undefined, ['security']).advise(request, { agent });

describe('EgressAdvisor', () => {
  it('withholds a credential leaving for an allowed host', async () => {
    const advisories = await advise({
      action: 'http.request',
      target: 'https://api.partner.example',
      arguments: { body: `token=${AWS_KEY}` },
    });

    expect(advisories).toHaveLength(1);
    expect(advisories[0]?.escalateTo).toBe(DECISION_EFFECT.WITHHOLD);
    expect(advisories[0]?.reason).toContain('body');
    expect(advisories[0]?.signals).toContain(RISK_SIGNAL_CREDENTIAL_EGRESS);
    expect(advisories[0]?.signals).toContain('field:body');
  });

  it('never names the value, only the field', async () => {
    const [advisory] = await advise({
      action: 'http.request',
      target: 'https://example.com',
      arguments: { payload: AWS_KEY },
    });
    expect(JSON.stringify(advisory)).not.toContain(AWS_KEY);
  });

  it('says nothing about an ordinary request', async () => {
    expect(
      await advise({
        action: 'http.request',
        target: 'https://example.com',
        arguments: { body: 'hello' },
      }),
    ).toEqual([]);
  });

  it('says nothing about an action that carries no payload anywhere', async () => {
    expect(await advise({ action: 'code.read', arguments: { body: AWS_KEY } })).toEqual(
      [],
    );
  });

  /** Over the wire the SDK strips arguments, so this must be silent rather than wrong. */
  it('says nothing when no arguments were reported', async () => {
    expect(await advise({ action: 'http.request', target: 'https://x' })).toEqual([]);
  });
});
