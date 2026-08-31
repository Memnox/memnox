import { beforeEach, describe, expect, it } from 'vitest';
import { AGENT_KIND, DECISION_EFFECT, isLeaseLive, type Capability } from '@memnox/core';
import { PolicyEngine, type Policy } from '@memnox/policy-engine';
import { ActionGateway } from '../src/action-gateway';
import { CapabilityBroker, LEASE_REFUSAL } from '../src/capability-broker';
import { CONSOLE_LOGGER } from '../src/console-logger';
import { InMemoryApprovalStore } from '../src/stores/in-memory-approval-store';
import { InMemoryAuditLog } from '../src/stores/in-memory-audit-log';
import {
  InMemoryCapabilityStore,
  InMemoryLeaseStore,
} from '../src/stores/in-memory-capability-store';
import { InMemoryIdentityStore } from '../src/stores/in-memory-identity-store';

const POLICIES: Policy[] = [
  {
    name: 'no-production-refunds',
    match: { actions: ['capability.issue.refund.create'], environments: ['production'] },
    decision: {
      effect: DECISION_EFFECT.WITHHOLD,
      reason: 'refunds need a person in production',
    },
  },
];

const NOW = new Date('2026-08-31T09:00:00.000Z');

describe('the capability broker', () => {
  let broker: CapabilityBroker;
  let gateway: ActionGateway;
  let leases: InMemoryLeaseStore;
  let auditLog: InMemoryAuditLog;
  let token: string;
  let agentId: string;

  const capability = (over: Partial<Capability> = {}): Capability => ({
    id: 'cap_refund',
    agentId,
    operation: 'refund.create',
    scope: { customer: 'cus_1' },
    ttlSeconds: 300,
    ...over,
  });

  beforeEach(async () => {
    auditLog = new InMemoryAuditLog();
    leases = new InMemoryLeaseStore();
    gateway = new ActionGateway({
      identityStore: new InMemoryIdentityStore(),
      auditLog,
      approvalStore: new InMemoryApprovalStore(),
      policyEngine: new PolicyEngine(POLICIES),
    });
    const registered = await gateway.registerAgent('support-bot', AGENT_KIND.CUSTOM);
    token = registered.token;
    agentId = registered.agent.id;
    broker = new CapabilityBroker({
      capabilities: new InMemoryCapabilityStore(),
      leases,
      gateway,
      logger: CONSOLE_LOGGER,
      clock: () => NOW,
    });
    await broker.grant(capability());
  });

  it('mints a lease scoped to one operation and a few minutes, not a key', async () => {
    const outcome = await broker.issue(token, {
      capabilityId: 'cap_refund',
      target: 'cus_1',
      scope: { customer: 'cus_1' },
    });

    expect(outcome.issued).toBe(true);
    if (!outcome.issued) return;
    expect(outcome.lease.expiresAt).toBe('2026-08-31T09:05:00.000Z');
    expect(isLeaseLive(outcome.lease, NOW)).toBe(true);
  });

  it('records every lease as a decision, so the ledger says why it was held', async () => {
    const outcome = await broker.issue(token, {
      capabilityId: 'cap_refund',
      target: 'cus_1',
      scope: { customer: 'cus_1' },
    });

    expect(outcome.issued).toBe(true);
    if (!outcome.issued) return;
    const [event] = await auditLog.query({ eventId: outcome.lease.decisionId, limit: 1 });
    expect(event?.action).toBe('capability.issue.refund.create');
  });

  it('refuses a scope wider than the capability, because a scope only narrows', async () => {
    const outcome = await broker.issue(token, {
      capabilityId: 'cap_refund',
      target: 'cus_9',
      scope: { customer: 'cus_9' },
    });

    expect(outcome).toEqual({ issued: false, reason: LEASE_REFUSAL.OUT_OF_SCOPE });
  });

  it('refuses when policy withholds the issue, and names the verdict that did it', async () => {
    const outcome = await broker.issue(token, {
      capabilityId: 'cap_refund',
      target: 'cus_1',
      scope: { customer: 'cus_1' },
      environment: 'production',
    });

    expect(outcome.issued).toBe(false);
    if (outcome.issued) return;
    expect(outcome.reason).toContain('refunds need a person');
    expect(outcome.decisionId).toBeDefined();
  });

  it('will not redeem a lease past its expiry, whatever the holder believes', async () => {
    const outcome = await broker.issue(token, {
      capabilityId: 'cap_refund',
      target: 'cus_1',
      scope: { customer: 'cus_1' },
    });
    expect(outcome.issued).toBe(true);
    if (!outcome.issued) return;

    const later = new CapabilityBroker({
      capabilities: new InMemoryCapabilityStore(),
      leases,
      gateway,
      logger: CONSOLE_LOGGER,
      clock: () => new Date('2026-08-31T09:06:00.000Z'),
    });

    expect(await later.redeem(outcome.lease.id)).toBeNull();
  });

  it('revokes every live lease an agent holds, which is the half of kill that bites', async () => {
    await broker.issue(token, {
      capabilityId: 'cap_refund',
      target: 'cus_1',
      scope: { customer: 'cus_1' },
    });

    expect(await broker.revokeAllFor(agentId)).toBe(1);
    const held = await leases.listByAgent(agentId);
    expect(held.every((lease) => lease.revokedAt !== undefined)).toBe(true);
  });
});
