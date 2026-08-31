import { beforeEach, describe, expect, it } from 'vitest';
import {
  AGENT_KIND,
  AGENT_STATUS,
  APPROVAL_STATUS,
  DECISION_EFFECT,
  DECISION_REASON,
} from '@memnox/core';
import { PolicyEngine, type Policy } from '@memnox/policy-engine';
import { ActionGateway } from '../src/action-gateway';
import { InMemoryApprovalStore } from '../src/stores/in-memory-approval-store';
import { InMemoryAuditLog } from '../src/stores/in-memory-audit-log';
import { InMemoryIdentityStore } from '../src/stores/in-memory-identity-store';

const POLICIES: Policy[] = [
  {
    name: 'production-database-protection',
    match: { actions: ['database.delete'], environments: ['production'] },
    decision: { effect: DECISION_EFFECT.WITHHOLD, reason: 'No AI database deletion' },
  },
  {
    name: 'deploy-approval',
    match: { actions: ['deploy.*'], environments: ['production'] },
    decision: { effect: DECISION_EFFECT.ESCALATE, approvers: ['eng-lead'] },
  },
];

describe('ActionGateway', () => {
  let gateway: ActionGateway;
  let auditLog: InMemoryAuditLog;
  let identityStore: InMemoryIdentityStore;

  beforeEach(() => {
    auditLog = new InMemoryAuditLog();
    identityStore = new InMemoryIdentityStore();
    gateway = new ActionGateway({
      identityStore,
      auditLog,
      approvalStore: new InMemoryApprovalStore(),
      policyEngine: new PolicyEngine(POLICIES),
    });
  });

  it('blocks unknown agent tokens and audits the attempt as critical', async () => {
    const decision = await gateway.authorize('mnx_forged', { action: 'repository.read' });
    expect(decision.effect).toBe(DECISION_EFFECT.WITHHOLD);
    expect(decision.reason).toBe(DECISION_REASON.UNKNOWN_AGENT);

    const [event] = await auditLog.recent(1);
    expect(event?.agentId).toBe('unknown');
    expect(event?.riskLevel).toBe('critical');
  });

  it('allows unmatched actions and updates agent stats', async () => {
    const { agent, token } = await gateway.registerAgent(
      'claude-code',
      AGENT_KIND.CLAUDE_CODE,
    );
    const decision = await gateway.authorize(token, { action: 'repository.read' });
    expect(decision.effect).toBe(DECISION_EFFECT.ALLOW);

    const stored = await identityStore.findById(agent.id);
    expect(stored?.stats.allowed).toBe(1);
  });

  it('blocks policy violations and records the matched policy', async () => {
    const { token } = await gateway.registerAgent('claude-code', AGENT_KIND.CLAUDE_CODE);
    const decision = await gateway.authorize(token, {
      action: 'database.delete',
      target: 'users',
      environment: 'production',
    });
    expect(decision.effect).toBe(DECISION_EFFECT.WITHHOLD);
    expect(decision.matchedPolicies.map((p) => p.name)).toContain(
      'production-database-protection',
    );

    const [event] = await auditLog.recent(1);
    expect(event?.effect).toBe(DECISION_EFFECT.WITHHOLD);
    expect(event?.matchedPolicies).toContain('production-database-protection');
  });

  it('blocks actions outside a capability-scoped agent before policy evaluation', async () => {
    const { token } = await gateway.registerAgent('reader', AGENT_KIND.CUSTOM, [
      'repository.*',
    ]);
    const decision = await gateway.authorize(token, { action: 'database.migrate' });
    expect(decision.effect).toBe(DECISION_EFFECT.WITHHOLD);
    expect(decision.reason).toBe(DECISION_REASON.CAPABILITY);
    expect(decision.matchedPolicies).toHaveLength(0);

    const [event] = await auditLog.recent(1);
    expect(event?.effect).toBe(DECISION_EFFECT.WITHHOLD);
    expect(event?.reason).toBe(DECISION_REASON.CAPABILITY);
  });

  it('allows actions matching a capability pattern', async () => {
    const { token } = await gateway.registerAgent('reader', AGENT_KIND.CUSTOM, [
      'repository.*',
    ]);
    const decision = await gateway.authorize(token, { action: 'repository.read' });
    expect(decision.effect).toBe(DECISION_EFFECT.ALLOW);
  });

  it('leaves agents without capabilities unrestricted', async () => {
    const { token } = await gateway.registerAgent('open', AGENT_KIND.CUSTOM);
    const decision = await gateway.authorize(token, { action: 'database.migrate' });
    expect(decision.effect).toBe(DECISION_EFFECT.ALLOW);
  });

  it('blocks suspended agents regardless of policy', async () => {
    const { agent, token } = await gateway.registerAgent('rogue', AGENT_KIND.CUSTOM);
    await identityStore.save({ ...agent, status: AGENT_STATUS.SUSPENDED });
    const decision = await gateway.authorize(token, { action: 'repository.read' });
    expect(decision.effect).toBe(DECISION_EFFECT.WITHHOLD);
    expect(decision.reason).toBe(DECISION_REASON.AGENT_SUSPENDED);
  });

  it('runs the full approval lifecycle: pending → approved → allowed', async () => {
    const { token } = await gateway.registerAgent('claude-code', AGENT_KIND.CLAUDE_CODE);
    const request = {
      action: 'deploy.service',
      target: 'api',
      environment: 'production',
    };

    const first = await gateway.authorize(token, request);
    expect(first.effect).toBe(DECISION_EFFECT.ESCALATE);
    expect(first.approvalId).toBeDefined();

    const retryWhilePending = await gateway.authorize(token, {
      ...request,
      approvalId: first.approvalId,
    });
    expect(retryWhilePending.effect).toBe(DECISION_EFFECT.ESCALATE);
    expect(retryWhilePending.approvalId).toBe(first.approvalId);

    const approval = await gateway.approvals.resolve(
      first.approvalId ?? '',
      true,
      'eng-lead',
    );
    expect(approval.approval?.status).toBe(APPROVAL_STATUS.APPROVED);

    const second = await gateway.authorize(token, {
      ...request,
      approvalId: first.approvalId,
    });
    expect(second.effect).toBe(DECISION_EFFECT.ALLOW);
    expect(second.reason).toContain('eng-lead');
  });

  it('refuses an approval replayed against a different action', async () => {
    const { token } = await gateway.registerAgent('claude-code', AGENT_KIND.CLAUDE_CODE);
    const first = await gateway.authorize(token, {
      action: 'deploy.service',
      target: 'api',
      environment: 'production',
    });
    await gateway.approvals.resolve(first.approvalId ?? '', true, 'eng-lead');

    const replayed = await gateway.authorize(token, {
      action: 'database.delete',
      target: 'users',
      environment: 'production',
      approvalId: first.approvalId,
    });
    expect(replayed.effect).toBe(DECISION_EFFECT.WITHHOLD);
  });

  it('blocks after a denied approval', async () => {
    const { token } = await gateway.registerAgent('claude-code', AGENT_KIND.CLAUDE_CODE);
    const request = {
      action: 'deploy.service',
      target: 'api',
      environment: 'production',
    };
    const first = await gateway.authorize(token, request);
    await gateway.approvals.resolve(first.approvalId ?? '', false, 'eng-lead');

    const denied = await gateway.authorize(token, {
      ...request,
      approvalId: first.approvalId,
    });
    expect(denied.effect).toBe(DECISION_EFFECT.WITHHOLD);
    expect(denied.reason).toContain('denied');
  });
});
