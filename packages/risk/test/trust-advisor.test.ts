import { describe, expect, it } from 'vitest';
import { AGENT_KIND, AGENT_STATUS, DECISION_EFFECT } from '@memnox/core';
import type { AgentActionStats, AgentIdentity } from '@memnox/core';
import { TrustAdvisor } from '../src/trust-advisor';
import { RISK_SIGNAL, TRUST_SCORE_APPROVAL_THRESHOLD } from '../src/risk.constants';

// 21 blocks → score 58 (< 60); 20 blocks → exactly 60.
const LOW_TRUST_STATS: AgentActionStats = {
  allowed: 0,
  blocked: 21,
  approvalsRequested: 0,
};
const THRESHOLD_STATS: AgentActionStats = {
  allowed: 0,
  blocked: 20,
  approvalsRequested: 0,
};

function agent(stats: AgentActionStats): AgentIdentity {
  return {
    id: 'agent-1',
    name: 'claude-code',
    kind: AGENT_KIND.CLAUDE_CODE,
    status: AGENT_STATUS.ACTIVE,
    tokenHash: 'hash',
    createdAt: new Date().toISOString(),
    stats,
  };
}

describe('TrustAdvisor', () => {
  const advisor = new TrustAdvisor(['security-team']);

  it('requires approval when a low-trust agent attempts a high-risk action', async () => {
    const advisories = await advisor.advise(
      { action: 'database.delete' },
      { agent: agent(LOW_TRUST_STATS) },
    );
    expect(advisories).toHaveLength(1);
    expect(advisories[0]?.escalateTo).toBe(DECISION_EFFECT.REQUIRE_APPROVAL);
    expect(advisories[0]?.signals).toContain(RISK_SIGNAL.LOW_TRUST_SCORE);
    expect(advisories[0]?.approvers).toEqual(['security-team']);
  });

  it('escalates critical-risk actions from low-trust agents', async () => {
    const advisories = await advisor.advise(
      { action: 'database.delete', environment: 'production' },
      { agent: agent(LOW_TRUST_STATS) },
    );
    expect(advisories[0]?.escalateTo).toBe(DECISION_EFFECT.REQUIRE_APPROVAL);
  });

  it('stays quiet for low-risk actions even at low trust', async () => {
    const advisories = await advisor.advise(
      { action: 'repository.read' },
      { agent: agent(LOW_TRUST_STATS) },
    );
    expect(advisories).toHaveLength(0);
  });

  it('stays quiet for trusted agents on high-risk actions', async () => {
    const advisories = await advisor.advise(
      { action: 'database.delete' },
      { agent: agent({ allowed: 0, blocked: 0, approvalsRequested: 0 }) },
    );
    expect(advisories).toHaveLength(0);
  });

  it('does not escalate at exactly the threshold score', async () => {
    const advisories = await advisor.advise(
      { action: 'database.delete' },
      { agent: agent(THRESHOLD_STATS) },
    );
    expect(advisories).toHaveLength(0);
    expect(TRUST_SCORE_APPROVAL_THRESHOLD).toBe(60);
  });
});
