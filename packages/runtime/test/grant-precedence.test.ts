import { beforeEach, describe, expect, it } from 'vitest';
import {
  AGENT_KIND,
  AGENT_STATUS,
  APPROVAL_STATUS,
  DECISION_EFFECT,
  DECISION_REASON,
  InMemorySessionTaintStore,
  type ActionRequest,
  type AgentIdentity,
  type Approval,
} from '@memnox/core';
import { TaintAdvisor } from '@memnox/risk';
import { PolicyEngine, type Policy } from '@memnox/policy-engine';
import { ActionGateway } from '../src/action-gateway';
import { InMemoryApprovalStore } from '../src/stores/in-memory-approval-store';
import { InMemoryAuditLog } from '../src/stores/in-memory-audit-log';
import { InMemoryIdentityStore } from '../src/stores/in-memory-identity-store';
import { fingerprintRequest } from '../src/token';

const POLICIES: Policy[] = [
  {
    name: 'drops-need-approval',
    match: { actions: ['database.drop'] },
    decision: { effect: DECISION_EFFECT.REQUIRE_APPROVAL, approvers: ['dba'] },
  },
  {
    name: 'deletes-need-approval',
    match: { actions: ['project.delete'] },
    decision: { effect: DECISION_EFFECT.REQUIRE_APPROVAL, approvers: ['eng-lead'] },
  },
];

const TAINTED = {
  tainted: true,
  sources: [{ sourceType: 'github_issue', reason: 'authored by NONE' }],
};

/**
 * A granted approval is consent for one action — it is not a master key. These
 * are the guards that outrank one, each proved against a real unspent grant
 * sitting in the store rather than against an empty one.
 */
describe('what outranks a granted approval', () => {
  let gateway: ActionGateway;
  let approvalStore: InMemoryApprovalStore;
  let identityStore: InMemoryIdentityStore;
  let auditLog: InMemoryAuditLog;

  beforeEach(() => {
    approvalStore = new InMemoryApprovalStore();
    identityStore = new InMemoryIdentityStore();
    auditLog = new InMemoryAuditLog();
    gateway = new ActionGateway({
      identityStore,
      auditLog,
      approvalStore,
      policyEngine: new PolicyEngine(POLICIES),
      advisors: [new TaintAdvisor(new InMemorySessionTaintStore())],
    });
  });

  /** An approval a human really did grant, for exactly this action, never spent. */
  const seedGrant = async (
    agent: AgentIdentity,
    request: ActionRequest,
  ): Promise<Approval> => {
    const grant: Approval = {
      id: 'apr_seeded',
      requestFingerprint: fingerprintRequest({
        agentId: agent.id,
        action: request.action,
        target: request.target,
        environment: request.environment,
      }),
      agentId: agent.id,
      action: request.action,
      target: request.target,
      approvers: ['dba'],
      minApprovals: 1,
      grants: [{ by: 'dana', at: new Date().toISOString() }],
      status: APPROVAL_STATUS.APPROVED,
      createdAt: new Date().toISOString(),
      resolvedBy: 'dana',
    };
    await approvalStore.save(grant);
    return grant;
  };

  const stored = async (id: string): Promise<Approval | null> =>
    approvalStore.findById(id);

  it('honours the grant when nothing outranks it — the control case', async () => {
    const { agent, token } = await gateway.registerAgent('dba-bot', AGENT_KIND.CUSTOM);
    const request: ActionRequest = { action: 'database.drop', target: 'staging_users' };
    await seedGrant(agent, request);

    const decision = await gateway.authorize(token, request);

    expect(decision.effect).toBe(DECISION_EFFECT.ALLOW);
    expect(decision.reason).toContain('dana');
    // Spent, so the next identical attempt asks again.
    expect((await stored('apr_seeded'))?.consumedAt).toBeDefined();
  });

  it('capability bounds outrank it, and leave the grant unspent', async () => {
    const { agent, token } = await gateway.registerAgent('reader', AGENT_KIND.CUSTOM, [
      'repository.*',
    ]);
    const request: ActionRequest = { action: 'database.drop', target: 'staging_users' };
    await seedGrant(agent, request);

    const decision = await gateway.authorize(token, request);

    expect(decision.effect).toBe(DECISION_EFFECT.BLOCK);
    expect(decision.reason).toBe(DECISION_REASON.CAPABILITY);
    // Never reached the claim path, so the human's grant is still theirs to spend.
    expect((await stored('apr_seeded'))?.consumedAt).toBeUndefined();
  });

  it('suspension outranks it', async () => {
    const { agent, token } = await gateway.registerAgent('rogue', AGENT_KIND.CUSTOM);
    const request: ActionRequest = { action: 'database.drop', target: 'staging_users' };
    await seedGrant(agent, request);
    await identityStore.save({ ...agent, status: AGENT_STATUS.SUSPENDED });

    const decision = await gateway.authorize(token, request);

    expect(decision.effect).toBe(DECISION_EFFECT.BLOCK);
    expect(decision.reason).toBe(DECISION_REASON.AGENT_SUSPENDED);
    expect((await stored('apr_seeded'))?.consumedAt).toBeUndefined();
  });

  it('a non-overridable taint block outranks it', async () => {
    const { agent, token } = await gateway.registerAgent('agent', AGENT_KIND.CUSTOM);
    const request: ActionRequest = {
      action: 'database.drop',
      target: 'users',
      sessionId: 'sess-1',
      taint: TAINTED,
    };
    await seedGrant(agent, request);

    const decision = await gateway.authorize(token, request);

    expect(decision.effect).toBe(DECISION_EFFECT.BLOCK);
    // The advisory's own words: it escalated to block before any approval was
    // consulted, which is why the reason is not the approval-veto phrasing.
    expect(decision.reason).toContain('no approval can unblock it');
    expect((await stored('apr_seeded'))?.consumedAt).toBeUndefined();
  });

  it('blocks the other irreversible action the same way', async () => {
    const { agent, token } = await gateway.registerAgent('agent', AGENT_KIND.CUSTOM);
    const request: ActionRequest = {
      action: 'project.delete',
      target: 'acme',
      sessionId: 'sess-2',
      taint: TAINTED,
    };
    await seedGrant(agent, request);

    const decision = await gateway.authorize(token, request);

    expect(decision.effect).toBe(DECISION_EFFECT.BLOCK);
    expect(decision.reason).toContain('no approval can unblock it');
  });

  it('a grant for one target does not authorize another', async () => {
    const { agent, token } = await gateway.registerAgent('dba-bot', AGENT_KIND.CUSTOM);
    await seedGrant(agent, { action: 'database.drop', target: 'staging_users' });

    const decision = await gateway.authorize(token, {
      action: 'database.drop',
      target: 'production_users',
    });

    expect(decision.effect).toBe(DECISION_EFFECT.REQUIRE_APPROVAL);
    expect(decision.approvalId).not.toBe('apr_seeded');
    expect((await stored('apr_seeded'))?.consumedAt).toBeUndefined();
  });

  it('a grant for one agent does not authorize another agent', async () => {
    const { agent } = await gateway.registerAgent('first', AGENT_KIND.CUSTOM);
    const other = await gateway.registerAgent('second', AGENT_KIND.CUSTOM);
    const request: ActionRequest = { action: 'database.drop', target: 'staging_users' };
    await seedGrant(agent, request);

    const decision = await gateway.authorize(other.token, request);

    expect(decision.effect).toBe(DECISION_EFFECT.REQUIRE_APPROVAL);
    expect((await stored('apr_seeded'))?.consumedAt).toBeUndefined();
  });
});
