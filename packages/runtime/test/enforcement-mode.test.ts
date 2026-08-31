import { beforeEach, describe, expect, it } from 'vitest';
import {
  AGENT_KIND,
  APPROVAL_STATUS,
  DECISION_EFFECT,
  ENFORCEMENT_MODE,
  type EnvironmentModes,
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

const DELETE_REQUEST = {
  action: 'database.delete',
  target: 'production.users',
  environment: 'production',
};

describe('enforcement modes', () => {
  let auditLog: InMemoryAuditLog;
  let approvalStore: InMemoryApprovalStore;

  const gatewayWith = (enforcement: EnvironmentModes): ActionGateway =>
    new ActionGateway({
      identityStore: new InMemoryIdentityStore(),
      auditLog,
      approvalStore,
      policyEngine: new PolicyEngine(POLICIES),
      enforcement,
    });

  const agentToken = async (gateway: ActionGateway): Promise<string> => {
    const { token } = await gateway.registerAgent('claude-code', AGENT_KIND.CLAUDE_CODE);
    return token;
  };

  beforeEach(() => {
    auditLog = new InMemoryAuditLog();
    approvalStore = new InMemoryApprovalStore();
  });

  describe('enforce', () => {
    it('applies a blocking verdict', async () => {
      const gateway = gatewayWith({
        environments: { production: ENFORCEMENT_MODE.ENFORCE },
      });
      const decision = await gateway.authorize(await agentToken(gateway), DELETE_REQUEST);

      expect(decision.effect).toBe(DECISION_EFFECT.WITHHOLD);
      expect(decision.shadowEffect).toBeUndefined();
    });
  });

  describe('observe', () => {
    it('lets the action through but records what policy decided', async () => {
      const gateway = gatewayWith({
        environments: { production: ENFORCEMENT_MODE.OBSERVE },
      });
      const decision = await gateway.authorize(await agentToken(gateway), DELETE_REQUEST);

      expect(decision.effect).toBe(DECISION_EFFECT.ALLOW);
      expect(decision.shadowEffect).toBe(DECISION_EFFECT.WITHHOLD);
      expect(decision.matchedPolicies.map((policy) => policy.name)).toContain(
        'production-database-protection',
      );

      const [event] = await auditLog.recent(1);
      expect(event?.effect).toBe(DECISION_EFFECT.ALLOW);
      expect(event?.shadowEffect).toBe(DECISION_EFFECT.WITHHOLD);
      expect(event?.enforcementMode).toBe(ENFORCEMENT_MODE.OBSERVE);
    });

    // An approval raised in monitor mode would page a human about an action that
    // already ran — the queue must stay empty.
    it('does not raise an approval for a withheld require_approval', async () => {
      const gateway = gatewayWith({
        environments: { production: ENFORCEMENT_MODE.OBSERVE },
      });
      const decision = await gateway.authorize(await agentToken(gateway), {
        action: 'deploy.service',
        environment: 'production',
      });

      expect(decision.effect).toBe(DECISION_EFFECT.ALLOW);
      expect(decision.shadowEffect).toBe(DECISION_EFFECT.ESCALATE);
      expect(decision.approvalId).toBeUndefined();
      expect(await approvalStore.listByStatus(APPROVAL_STATUS.PENDING)).toHaveLength(0);
    });

    // Fail-closed: unconfigured means enforce, so an upgrade cannot silently
    // turn a blocking deployment into an observing one.
    it('is not the default — an unconfigured environment enforces', async () => {
      const gateway = gatewayWith({});
      const decision = await gateway.authorize(await agentToken(gateway), DELETE_REQUEST);

      expect(decision.effect).toBe(DECISION_EFFECT.WITHHOLD);
      expect(decision.shadowEffect).toBeUndefined();
    });

    it('leaves an allowed action indistinguishable from enforced', async () => {
      const gateway = gatewayWith({ default: ENFORCEMENT_MODE.OBSERVE });
      const decision = await gateway.authorize(await agentToken(gateway), {
        action: 'repository.read',
      });

      expect(decision.effect).toBe(DECISION_EFFECT.ALLOW);
      expect(decision.shadowEffect).toBeUndefined();
    });
  });

  describe('off', () => {
    it('allows without evaluating any policy', async () => {
      const gateway = gatewayWith({ environments: { production: ENFORCEMENT_MODE.OFF } });
      const decision = await gateway.authorize(await agentToken(gateway), DELETE_REQUEST);

      expect(decision.effect).toBe(DECISION_EFFECT.ALLOW);
      expect(decision.matchedPolicies).toEqual([]);

      // Still audited: disabling governance must not disable the record of it.
      const [event] = await auditLog.recent(1);
      expect(event?.action).toBe('database.delete');
      expect(event?.enforcementMode).toBe(ENFORCEMENT_MODE.OFF);
    });
  });

  describe('per-environment isolation', () => {
    it('enforces production while monitoring staging with one rule set', async () => {
      const gateway = gatewayWith({
        default: ENFORCEMENT_MODE.OBSERVE,
        environments: { production: ENFORCEMENT_MODE.ENFORCE },
      });
      const token = await agentToken(gateway);

      const prod = await gateway.authorize(token, DELETE_REQUEST);
      const staging = await gateway.authorize(token, {
        ...DELETE_REQUEST,
        environment: 'staging',
      });

      expect(prod.effect).toBe(DECISION_EFFECT.WITHHOLD);
      // The staging policy only matches production, so nothing was withheld either.
      expect(staging.effect).toBe(DECISION_EFFECT.ALLOW);
      expect(staging.shadowEffect).toBeUndefined();
    });
  });

  // Monitoring a policy is a choice; admitting an unknown caller is not.
  describe('identity is never relaxed', () => {
    it('still blocks an unknown token with governance off', async () => {
      const gateway = gatewayWith({ default: ENFORCEMENT_MODE.OFF });
      const decision = await gateway.authorize('mnx_forged', DELETE_REQUEST);

      expect(decision.effect).toBe(DECISION_EFFECT.WITHHOLD);
    });

    it('still blocks an unknown token in monitor mode', async () => {
      const gateway = gatewayWith({ default: ENFORCEMENT_MODE.OBSERVE });
      const decision = await gateway.authorize('mnx_forged', DELETE_REQUEST);

      expect(decision.effect).toBe(DECISION_EFFECT.WITHHOLD);
      expect(decision.shadowEffect).toBeUndefined();
    });
  });
});
