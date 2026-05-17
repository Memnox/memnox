import { describe, expect, it } from 'vitest';
import {
  AGENT_KIND,
  AGENT_STATUS,
  EMPTY_AGENT_STATS,
  type ActionEvent,
  type AgentIdentity,
  type AuditChainVerification,
  type AuditLog,
  type AuditQuery,
} from '@memnox/core';
import { BehaviorAdvisor } from '../src/behavior-advisor';
import {
  BASELINE_WINDOW_EVENTS,
  TOKEN_BUDGET_WINDOW_EVENTS,
} from '../src/risk.constants';
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

/** Records the filters it is asked for — the point of the test is the arguments, not the rows. */
class RecordingAuditLog implements AuditLog {
  readonly filters: AuditQuery[] = [];

  async append(): Promise<void> {}
  async recent(): Promise<ActionEvent[]> {
    return [];
  }
  async query(filter: AuditQuery): Promise<ActionEvent[]> {
    this.filters.push(filter);
    return [];
  }
  async pruneBefore(): Promise<number> {
    return 0;
  }
  async verifyChain(): Promise<AuditChainVerification> {
    return { valid: true, checked: 0, brokenAtIndex: -1 };
  }
}

describe('advisors bound their own history window', () => {
  it('BehaviorAdvisor asks for the baseline window instead of the whole history', async () => {
    const auditLog = new RecordingAuditLog();
    await new BehaviorAdvisor(auditLog, ['team-lead']).advise(
      { action: 'database.delete' },
      { agent: AGENT },
    );
    expect(auditLog.filters).toEqual([
      { agentId: AGENT.id, limit: BASELINE_WINDOW_EVENTS },
    ]);
  });

  it('TokenBudgetAdvisor asks for the spend window', async () => {
    const auditLog = new RecordingAuditLog();
    await new TokenBudgetAdvisor(auditLog, 10_000).advise(
      { action: LLM_SPEND_ACTION, target: '500', sessionId: 'sess-1' },
      { agent: AGENT },
    );
    expect(auditLog.filters).toEqual([
      { sessionId: 'sess-1', limit: TOKEN_BUDGET_WINDOW_EVENTS },
    ]);
  });

  it('never issues an unbounded query on the authorize path', async () => {
    const auditLog = new RecordingAuditLog();
    await new BehaviorAdvisor(auditLog, ['team-lead']).advise(
      { action: 'database.delete', sessionId: 'sess-1' },
      { agent: AGENT },
    );
    await new TokenBudgetAdvisor(auditLog, 10_000).advise(
      { action: LLM_SPEND_ACTION, target: '500', sessionId: 'sess-1' },
      { agent: AGENT },
    );
    expect(auditLog.filters.every((filter) => (filter.limit ?? 0) > 0)).toBe(true);
  });
});
