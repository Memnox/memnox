import { describe, expect, it } from 'vitest';
import {
  AGENT_KIND,
  AGENT_STATUS,
  DECISION_EFFECT,
  EMPTY_AGENT_STATS,
} from '@memnox/core';
import type {
  ActionEvent,
  AgentIdentity,
  AuditChainVerification,
  AuditLog,
  AuditQuery,
} from '@memnox/core';
import { RISK_LEVEL } from '@memnox/core';
import { BehaviorAdvisor } from '../src/behavior-advisor';
import { REPEATED_BLOCK_THRESHOLD, RISK_SIGNAL } from '../src/risk.constants';

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

function event(overrides: Partial<ActionEvent>): ActionEvent {
  return {
    id: 'evt',
    occurredAt: new Date().toISOString(),
    agentId: AGENT.id,
    agentName: AGENT.name,
    action: 'repository.read',
    effect: DECISION_EFFECT.ALLOW,
    riskLevel: RISK_LEVEL.LOW,
    matchedPolicies: [],
    advisories: [],
    reason: 'ok',
    ...overrides,
  };
}

describe('BehaviorAdvisor', () => {
  it('requires approval for a destructive action the agent has never taken', async () => {
    const advisor = new BehaviorAdvisor(new StubAuditLog([event({}), event({})]), [
      'security-team',
    ]);
    const advisories = await advisor.advise(
      { action: 'database.delete' },
      { agent: AGENT },
    );
    expect(advisories.map((a) => a.signals).flat()).toContain(
      RISK_SIGNAL.NOVEL_DESTRUCTIVE_ACTION,
    );
    expect(advisories[0]?.escalateTo).toBe(DECISION_EFFECT.ESCALATE);
  });

  it('stays quiet for a destructive action the agent has done before', async () => {
    const advisor = new BehaviorAdvisor(
      new StubAuditLog([event({ action: 'database.delete' })]),
      ['security-team'],
    );
    const advisories = await advisor.advise(
      { action: 'database.delete' },
      { agent: AGENT },
    );
    expect(advisories).toHaveLength(0);
  });

  it('has no baseline opinion on a brand-new agent', async () => {
    const advisor = new BehaviorAdvisor(new StubAuditLog([]), ['security-team']);
    const advisories = await advisor.advise(
      { action: 'database.delete' },
      { agent: AGENT },
    );
    expect(advisories).toHaveLength(0);
  });

  it('escalates when an agent keeps hitting withholds', async () => {
    const withheld = Array.from({ length: REPEATED_BLOCK_THRESHOLD }, () =>
      event({ effect: DECISION_EFFECT.WITHHOLD }),
    );
    const advisor = new BehaviorAdvisor(new StubAuditLog(withheld), ['security-team']);
    const advisories = await advisor.advise(
      { action: 'repository.read' },
      { agent: AGENT },
    );
    expect(advisories.map((a) => a.signals).flat()).toContain(
      RISK_SIGNAL.REPEATED_BLOCKS,
    );
  });
});
