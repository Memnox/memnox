import { describe, expect, it } from 'vitest';
import {
  AGENT_KIND,
  AGENT_STATUS,
  DECISION_EFFECT,
  EMPTY_AGENT_STATS,
  RISK_LEVEL,
} from '@memnox/core';
import type {
  ActionEvent,
  AgentIdentity,
  AuditChainVerification,
  AuditLog,
  AuditQuery,
} from '@memnox/core';
import { LLM_SPEND_ACTION, TokenBudgetAdvisor } from '../src/token-budget-advisor';

const AGENT: AgentIdentity = {
  id: 'agent-1',
  name: 'claude-code',
  kind: AGENT_KIND.CLAUDE_CODE,
  status: AGENT_STATUS.ACTIVE,
  tokenHash: 'hash',
  createdAt: new Date().toISOString(),
  stats: { ...EMPTY_AGENT_STATS },
};

class StubAuditLog implements AuditLog {
  constructor(private readonly events: ActionEvent[]) {}
  async append(): Promise<void> {}
  async recent(): Promise<ActionEvent[]> {
    return this.events;
  }
  async query(_filter: AuditQuery): Promise<ActionEvent[]> {
    return this.events;
  }
  async pruneBefore(): Promise<number> {
    return 0;
  }
  async verifyChain(): Promise<AuditChainVerification> {
    return { valid: true, checked: this.events.length, brokenAtIndex: -1 };
  }
}

function spendEvent(tokens: number): ActionEvent {
  return {
    id: 'evt',
    occurredAt: new Date().toISOString(),
    agentId: AGENT.id,
    agentName: AGENT.name,
    action: LLM_SPEND_ACTION,
    target: String(tokens),
    sessionId: 'sess-1',
    effect: DECISION_EFFECT.ALLOW,
    riskLevel: RISK_LEVEL.MEDIUM,
    matchedPolicies: [],
    advisories: [],
    reason: 'ok',
  };
}

describe('TokenBudgetAdvisor', () => {
  const BUDGET = 10_000;

  it('allows spend within the session budget', async () => {
    const advisor = new TokenBudgetAdvisor(new StubAuditLog([spendEvent(4_000)]), BUDGET);
    const advisories = await advisor.advise(
      { action: LLM_SPEND_ACTION, target: '5000', sessionId: 'sess-1' },
      { agent: AGENT },
    );
    expect(advisories).toHaveLength(0);
  });

  it('blocks spend that would exceed the budget', async () => {
    const advisor = new TokenBudgetAdvisor(
      new StubAuditLog([spendEvent(4_000), spendEvent(4_000)]),
      BUDGET,
    );
    const advisories = await advisor.advise(
      { action: LLM_SPEND_ACTION, target: '5000', sessionId: 'sess-1' },
      { agent: AGENT },
    );
    expect(advisories[0]?.escalateTo).toBe(DECISION_EFFECT.BLOCK);
    expect(advisories[0]?.reason).toContain('13000 of 10000');
  });

  it('ignores non-spend actions and requests without a session', async () => {
    const advisor = new TokenBudgetAdvisor(new StubAuditLog([]), BUDGET);
    expect(
      await advisor.advise(
        { action: 'repository.read', sessionId: 'sess-1' },
        { agent: AGENT },
      ),
    ).toHaveLength(0);
    expect(
      await advisor.advise(
        { action: LLM_SPEND_ACTION, target: '5000' },
        { agent: AGENT },
      ),
    ).toHaveLength(0);
  });
});
