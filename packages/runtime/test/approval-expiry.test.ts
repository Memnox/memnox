import { beforeEach, describe, expect, it } from 'vitest';
import { AGENT_KIND, APPROVAL_STATUS, DECISION_EFFECT } from '@memnox/core';
import { PolicyEngine, type Policy } from '@memnox/policy-engine';
import { ActionGateway } from '../src/action-gateway';
import { InMemoryApprovalStore } from '../src/stores/in-memory-approval-store';
import { InMemoryAuditLog } from '../src/stores/in-memory-audit-log';
import { InMemoryIdentityStore } from '../src/stores/in-memory-identity-store';

const POLICIES: Policy[] = [
  {
    name: 'hold-everything',
    match: { actions: ['review.*'] },
    decision: { effect: DECISION_EFFECT.REQUIRE_APPROVAL, approvers: ['lead'] },
  },
];

const LONG_PAST = '2020-01-01T00:00:00.000Z';
const CEILING = 3;

/**
 * The stores hand lapsed holds straight back — TTL is the service's rule. These
 * drive InMemoryApprovalStore, which filters nothing, exactly like Postgres.
 */
describe('lapsed approvals', () => {
  let gateway: ActionGateway;
  let approvalStore: InMemoryApprovalStore;
  let token: string;

  beforeEach(async () => {
    approvalStore = new InMemoryApprovalStore();
    gateway = new ActionGateway({
      identityStore: new InMemoryIdentityStore(),
      auditLog: new InMemoryAuditLog(),
      approvalStore,
      policyEngine: new PolicyEngine(POLICIES),
      enforcement: { default: 'enforce' },
      maxPendingPerAgent: CEILING,
    });
    ({ token } = await gateway.registerAgent('claude-code', AGENT_KIND.CLAUDE_CODE));
  });

  const ask = (n: number) => gateway.authorize(token, { action: `review.item${n}` });

  /** Ages a hold past its TTL without waiting seven days for one. */
  async function lapse(approvalId: string): Promise<void> {
    const approval = await approvalStore.findById(approvalId);
    if (approval === null) throw new Error('expected an approval to lapse');
    await approvalStore.save({ ...approval, expiresAt: LONG_PAST });
  }

  it('raises a fresh hold instead of handing back the lapsed one', async () => {
    const first = await ask(0);
    if (first.approvalId === undefined) throw new Error('expected an approval');
    await lapse(first.approvalId);

    const retry = await ask(0);
    expect(retry.effect).toBe(DECISION_EFFECT.REQUIRE_APPROVAL);
    expect(retry.approvalId).toBeTruthy();
    expect(retry.approvalId).not.toBe(first.approvalId);
  });

  it('retires the lapsed hold so nobody can still act on it', async () => {
    const first = await ask(0);
    if (first.approvalId === undefined) throw new Error('expected an approval');
    await lapse(first.approvalId);
    await ask(0);

    const retired = await approvalStore.findById(first.approvalId);
    expect(retired?.status).toBe(APPROVAL_STATUS.EXPIRED);
  });

  it('omits lapsed holds from the approver queue', async () => {
    const first = await ask(0);
    if (first.approvalId === undefined) throw new Error('expected an approval');
    await lapse(first.approvalId);

    expect(await gateway.approvals.pending()).toHaveLength(0);
    // The store itself still has it — the filter is the service's, not the adapter's.
    expect(await approvalStore.listByStatus(APPROVAL_STATUS.PENDING)).toHaveLength(1);
  });

  it('does not let lapsed holds consume the per-agent ceiling', async () => {
    for (let n = 0; n < CEILING; n += 1) {
      const decision = await ask(n);
      if (decision.approvalId === undefined) throw new Error('expected an approval');
      await lapse(decision.approvalId);
    }

    const overflow = await ask(99);
    expect(overflow.effect).toBe(DECISION_EFFECT.REQUIRE_APPROVAL);
    expect(overflow.approvalId).toBeTruthy();
  });
});
