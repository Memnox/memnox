import { beforeEach, describe, expect, it } from 'vitest';
import type { ActionAdvisor, Approval, ApprovalNotifier } from '@memnox/core';
import { AGENT_KIND, DECISION_EFFECT } from '@memnox/core';
import { PolicyEngine } from '@memnox/policy-engine';
import { ActionGateway } from '../src/action-gateway';
import { InMemoryApprovalStore } from '../src/stores/in-memory-approval-store';
import { InMemoryAuditLog } from '../src/stores/in-memory-audit-log';
import { InMemoryIdentityStore } from '../src/stores/in-memory-identity-store';

const blockingAdvisor: ActionAdvisor = {
  name: 'test-blocker',
  advise: async () => [
    {
      source: 'test-blocker',
      escalateTo: DECISION_EFFECT.WITHHOLD,
      reason: 'conflicts with a recorded decision',
      signals: ['decision:dec-1'],
    },
  ],
};

const failingAdvisor: ActionAdvisor = {
  name: 'broken',
  advise: async () => {
    throw new Error('advisor exploded');
  },
};

describe('ActionGateway advisors', () => {
  let auditLog: InMemoryAuditLog;

  beforeEach(() => {
    auditLog = new InMemoryAuditLog();
  });

  function buildGateway(
    advisors: ActionAdvisor[],
    notifier?: ApprovalNotifier,
  ): ActionGateway {
    return new ActionGateway({
      identityStore: new InMemoryIdentityStore(),
      auditLog,
      approvalStore: new InMemoryApprovalStore(),
      policyEngine: new PolicyEngine([]),
      advisors,
      notifier,
    });
  }

  it('lets an advisor escalate an otherwise-allowed action', async () => {
    const gateway = buildGateway([blockingAdvisor]);
    const { token } = await gateway.registerAgent('claude-code', AGENT_KIND.CLAUDE_CODE);
    const decision = await gateway.authorize(token, { action: 'database.migrate' });

    expect(decision.effect).toBe(DECISION_EFFECT.WITHHOLD);
    expect(decision.reason).toContain('recorded decision');

    const [event] = await auditLog.recent(1);
    expect(event?.advisories).toContain('test-blocker:decision:dec-1');
  });

  it('continues when an advisor fails — failure means no escalation, never a crash', async () => {
    const gateway = buildGateway([failingAdvisor]);
    const { token } = await gateway.registerAgent('claude-code', AGENT_KIND.CLAUDE_CODE);
    const decision = await gateway.authorize(token, { action: 'repository.read' });
    expect(decision.effect).toBe(DECISION_EFFECT.ALLOW);
  });

  it('notifies exactly once when a new approval is created', async () => {
    const notified: Approval[] = [];
    const approvingAdvisor: ActionAdvisor = {
      name: 'approver',
      advise: async () => [
        {
          source: 'approver',
          escalateTo: DECISION_EFFECT.ESCALATE,
          reason: 'needs a human',
          approvers: ['team-lead'],
          signals: ['needs-human'],
        },
      ],
    };
    const gateway = buildGateway([approvingAdvisor], {
      notify: async (approval) => {
        notified.push(approval);
      },
    });
    const { token } = await gateway.registerAgent('claude-code', AGENT_KIND.CLAUDE_CODE);

    const first = await gateway.authorize(token, { action: 'deploy.service' });
    const second = await gateway.authorize(token, { action: 'deploy.service' });

    expect(first.effect).toBe(DECISION_EFFECT.ESCALATE);
    expect(second.approvalId).toBe(first.approvalId);
    expect(notified).toHaveLength(1);
    expect(notified[0]?.approvers).toEqual(['team-lead']);
  });
});
