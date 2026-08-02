import { describe, expect, it } from 'vitest';
import {
  AGENT_KIND,
  AGENT_STATUS,
  DECISION_EFFECT,
  EMPTY_AGENT_STATS,
  EXECUTION_OUTCOME_ACTION,
  EXECUTION_OUTCOME_GRACE_MS,
  RISK_LEVEL,
} from '@memnox/core';
import type {
  ActionEvent,
  AgentIdentity,
  AuditChainVerification,
  AuditLog,
  AuditQuery,
} from '@memnox/core';
import { LLM_SPEND_ACTION } from '../src/token-budget-advisor';
import { VerificationAdvisor } from '../src/verification-advisor';
import { RISK_SIGNAL, UNREPORTED_OUTCOME_THRESHOLD } from '../src/risk.constants';

const AGENT: AgentIdentity = {
  id: 'agent-1',
  name: 'claude-code',
  kind: AGENT_KIND.CLAUDE_CODE,
  status: AGENT_STATUS.ACTIVE,
  tokenHash: 'hash',
  createdAt: new Date().toISOString(),
  stats: { ...EMPTY_AGENT_STATS },
};

const APPROVERS = ['eng-lead'];

/** Old enough that testimony is overdue rather than merely late. */
const overdueAt = (): string =>
  new Date(Date.now() - EXECUTION_OUTCOME_GRACE_MS * 2).toISOString();

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
    occurredAt: overdueAt(),
    agentId: AGENT.id,
    agentName: AGENT.name,
    action: 'code.modify',
    effect: DECISION_EFFECT.ALLOW,
    riskLevel: RISK_LEVEL.LOW,
    matchedPolicies: [],
    advisories: [],
    reason: 'no policy matched',
    ...overrides,
  };
}

/** `count` allowed decisions, none of which ever reported an outcome. */
const unreported = (count: number, over: Partial<ActionEvent> = {}): ActionEvent[] =>
  Array.from({ length: count }, (_, index) => event({ id: `evt-${index}`, ...over }));

const advise = (history: ActionEvent[], action = 'database.delete') =>
  new VerificationAdvisor(new StubAuditLog(history), APPROVERS).advise(
    { action },
    { agent: AGENT },
  );

describe('VerificationAdvisor', () => {
  it('sends a destructive action to a human once outcomes go unreported', async () => {
    const advisories = await advise(unreported(UNREPORTED_OUTCOME_THRESHOLD));

    expect(advisories).toHaveLength(1);
    expect(advisories[0]?.escalateTo).toBe(DECISION_EFFECT.REQUIRE_APPROVAL);
    expect(advisories[0]?.signals).toEqual([RISK_SIGNAL.UNVERIFIED_EXECUTION]);
    expect(advisories[0]?.approvers).toEqual(APPROVERS);
    expect(advisories[0]?.reason).toContain(`${UNREPORTED_OUTCOME_THRESHOLD}`);
  });

  it('stays silent below the threshold', async () => {
    expect(await advise(unreported(UNREPORTED_OUTCOME_THRESHOLD - 1))).toEqual([]);
  });

  it('leaves non-destructive actions alone however unverified the trail', async () => {
    const history = unreported(UNREPORTED_OUTCOME_THRESHOLD * 3);

    // Escalating reads because a caller never wired up runGuarded would wedge work.
    expect(await advise(history, 'repository.read')).toEqual([]);
  });

  it('does not count decisions that reported an outcome', async () => {
    const history = [
      ...unreported(UNREPORTED_OUTCOME_THRESHOLD),
      ...unreported(UNREPORTED_OUTCOME_THRESHOLD).map((decision) =>
        event({
          id: `${decision.id}-outcome`,
          action: EXECUTION_OUTCOME_ACTION,
          decisionEventId: decision.id,
        }),
      ),
    ];

    expect(await advise(history)).toEqual([]);
  });

  it('does not count decisions too recent for testimony to be overdue', async () => {
    const history = unreported(UNREPORTED_OUTCOME_THRESHOLD, {
      occurredAt: new Date().toISOString(),
    });

    expect(await advise(history)).toEqual([]);
  });

  it('does not count bookkeeping records — nobody reports an outcome for those', async () => {
    const history = unreported(UNREPORTED_OUTCOME_THRESHOLD, {
      action: LLM_SPEND_ACTION,
    });

    expect(await advise(history)).toEqual([]);
  });

  it('ignores blocked decisions — nothing ran, so nothing can be reported', async () => {
    const history = unreported(UNREPORTED_OUTCOME_THRESHOLD, {
      effect: DECISION_EFFECT.BLOCK,
    });

    expect(await advise(history)).toEqual([]);
  });
});
