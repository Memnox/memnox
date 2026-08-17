import { beforeEach, describe, expect, it } from 'vitest';
import {
  AGENT_KIND,
  APPROVAL_STATUS,
  DECISION_EFFECT,
  DECISION_REASON,
  InMemorySessionTaintStore,
} from '@memnox/core';
import type { ActionEvent, AuditQuery, TaintAssessment } from '@memnox/core';
import { PolicyEngine, type Policy } from '@memnox/policy-engine';
import { TaintAdvisor } from '@memnox/risk';
import { ActionGateway } from '../src/action-gateway';
import { OVERRIDE_OUTCOME } from '../src/approval-service';
import { InMemoryApprovalStore } from '../src/stores/in-memory-approval-store';
import { InMemoryAuditLog } from '../src/stores/in-memory-audit-log';
import { InMemoryIdentityStore } from '../src/stores/in-memory-identity-store';

const SESSION_ID = 'sess-1';

const EMAIL_TAINT: TaintAssessment = {
  tainted: true,
  sources: [{ sourceType: 'email_message', reason: 'third-party email in context' }],
};

const POLICIES: Policy[] = [
  {
    name: 'project-deletion-approval',
    match: { actions: ['project.delete'] },
    decision: { effect: DECISION_EFFECT.REQUIRE_APPROVAL, approvers: ['eng-lead'] },
  },
];

/** Counts every filtered read so "the advisor no longer scans the audit log" is assertable. */
class QueryCountingAuditLog extends InMemoryAuditLog {
  readonly filters: AuditQuery[] = [];

  override async query(filter: AuditQuery): Promise<ActionEvent[]> {
    this.filters.push(filter);
    return super.query(filter);
  }
}

describe('session taint through the gateway', () => {
  let gateway: ActionGateway;
  let auditLog: QueryCountingAuditLog;

  beforeEach(() => {
    auditLog = new QueryCountingAuditLog();
    gateway = new ActionGateway({
      identityStore: new InMemoryIdentityStore(),
      auditLog,
      approvalStore: new InMemoryApprovalStore(),
      policyEngine: new PolicyEngine(POLICIES),
      advisors: [new TaintAdvisor(new InMemorySessionTaintStore())],
    });
  });

  it('carries taint across a session without ever querying the audit log', async () => {
    const { token } = await gateway.registerAgent('claude-code', AGENT_KIND.CLAUDE_CODE);

    const seed = await gateway.authorize(token, {
      action: 'repository.read',
      sessionId: SESSION_ID,
      taint: EMAIL_TAINT,
    });
    expect(seed.effect).toBe(DECISION_EFFECT.ALLOW);

    const later = await gateway.authorize(token, {
      action: 'file.write',
      target: 'payment/checkout.ts',
      sessionId: SESSION_ID,
    });
    expect(later.effect).toBe(DECISION_EFFECT.REQUIRE_APPROVAL);
    expect(auditLog.filters).toEqual([]);
    expect(await auditLog.recent(10)).toHaveLength(2);
  });

  it('appends exactly one audit event per request on the non-overridable path', async () => {
    const { token } = await gateway.registerAgent('claude-code', AGENT_KIND.CLAUDE_CODE);
    const decision = await gateway.authorize(token, {
      action: 'project.delete',
      target: 'acme',
      sessionId: SESSION_ID,
      taint: EMAIL_TAINT,
    });
    expect(decision.effect).toBe(DECISION_EFFECT.BLOCK);

    const events = await auditLog.recent(10);
    expect(events).toHaveLength(1);
    expect(events[0]?.effect).toBe(DECISION_EFFECT.BLOCK);
    expect(events[0]?.advisories).toContain('taint-guard:taint:email_message');
  });

  it('refuses to let an approval unblock a non-overridable action', async () => {
    const { token } = await gateway.registerAgent('claude-code', AGENT_KIND.CLAUDE_CODE);
    const request = { action: 'project.delete', target: 'acme' };

    // The approval is created while the session is clean, then replayed once it is tainted.
    const pending = await gateway.authorize(token, request);
    expect(pending.effect).toBe(DECISION_EFFECT.REQUIRE_APPROVAL);
    const approval = await gateway.approvals.resolve(
      pending.approvalId ?? '',
      true,
      'eng-lead',
    );
    expect(approval.approval?.status).toBe(APPROVAL_STATUS.APPROVED);

    const replayed = await gateway.authorize(token, {
      ...request,
      approvalId: pending.approvalId,
      sessionId: SESSION_ID,
      taint: EMAIL_TAINT,
    });
    expect(replayed.effect).toBe(DECISION_EFFECT.BLOCK);
    expect(replayed.reason).toContain(DECISION_REASON.NON_OVERRIDABLE);
    // Three on the record: the hold, the human granting it, and the refusal
    // that grant could not buy.
    const trail = await auditLog.recent(10);
    expect(trail.map((event) => event.effect)).toEqual([
      DECISION_EFFECT.BLOCK,
      DECISION_EFFECT.ALLOW,
      DECISION_EFFECT.REQUIRE_APPROVAL,
    ]);
  });

  it('refuses break-glass for the non-overridable action class and audits the attempt', async () => {
    const { token } = await gateway.registerAgent('claude-code', AGENT_KIND.CLAUDE_CODE);
    const pending = await gateway.authorize(token, {
      action: 'project.delete',
      target: 'acme',
    });

    const result = await gateway.approvals.override(
      pending.approvalId ?? '',
      'admin:root',
      'incident 42',
    );
    expect(result.outcome).toBe(OVERRIDE_OUTCOME.FORBIDDEN);
    expect(result.approval?.status).toBe(APPROVAL_STATUS.PENDING);

    const [event] = await auditLog.recent(1);
    expect(event?.effect).toBe(DECISION_EFFECT.BLOCK);
    expect(event?.reason).toContain(DECISION_REASON.NON_OVERRIDABLE);
  });
});
