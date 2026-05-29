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

/** Three is enough to show the boundary without a wall of setup. */
const CEILING = 3;

describe('approval ceiling', () => {
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

  const pending = () => approvalStore.listByStatus(APPROVAL_STATUS.PENDING);

  it('holds up to the ceiling', async () => {
    for (let n = 0; n < CEILING; n += 1) {
      const decision = await ask(n);
      expect(decision.effect).toBe(DECISION_EFFECT.REQUIRE_APPROVAL);
      expect(decision.approvalId).toBeTruthy();
    }
  });

  // An approver facing dozens of holds stops reading them.
  it('blocks past the ceiling instead of queueing another', async () => {
    for (let n = 0; n < CEILING; n += 1) await ask(n);

    const overflow = await ask(99);
    expect(overflow.effect).toBe(DECISION_EFFECT.BLOCK);
    expect(overflow.approvalId).toBeUndefined();
    expect(overflow.reason).toContain('already pending');
  });

  it('queues nothing hidden when it blocks', async () => {
    for (let n = 0; n < CEILING + 2; n += 1) await ask(n);

    expect(await pending()).toHaveLength(CEILING);
  });

  // Dedup must still win: the same action twice is one hold, not two seats.
  it('reuses an open approval rather than spending a slot', async () => {
    for (let n = 0; n < CEILING; n += 1) await ask(n);

    const repeat = await ask(0);
    expect(repeat.effect).toBe(DECISION_EFFECT.REQUIRE_APPROVAL);
    expect(await pending()).toHaveLength(CEILING);
  });

  it('frees a slot once an approval is resolved', async () => {
    for (let n = 0; n < CEILING; n += 1) await ask(n);
    const [first] = await pending();
    if (first === undefined) throw new Error('expected a pending approval');
    await approvalStore.save({ ...first, status: APPROVAL_STATUS.APPROVED });

    expect((await ask(99)).effect).toBe(DECISION_EFFECT.REQUIRE_APPROVAL);
  });

  it('counts per agent, so one noisy agent cannot starve another', async () => {
    for (let n = 0; n < CEILING; n += 1) await ask(n);
    const other = await gateway.registerAgent('cursor', AGENT_KIND.CURSOR);

    const decision = await gateway.authorize(other.token, { action: 'review.x' });
    expect(decision.effect).toBe(DECISION_EFFECT.REQUIRE_APPROVAL);
  });

  it('leaves the ceiling generous when nobody configures one', async () => {
    const uncapped = new ActionGateway({
      identityStore: new InMemoryIdentityStore(),
      auditLog: new InMemoryAuditLog(),
      approvalStore: new InMemoryApprovalStore(),
      policyEngine: new PolicyEngine(POLICIES),
      enforcement: { default: 'enforce' },
    });
    const agent = await uncapped.registerAgent('a', AGENT_KIND.CLAUDE_CODE);

    for (let n = 0; n < CEILING + 2; n += 1) {
      const decision = await uncapped.authorize(agent.token, {
        action: `review.item${n}`,
      });
      expect(decision.effect).toBe(DECISION_EFFECT.REQUIRE_APPROVAL);
    }
  });
});
