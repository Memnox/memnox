import { randomUUID } from 'node:crypto';
import type {
  ActionRequest,
  Capability,
  CapabilityStore,
  Lease,
  LeaseStore,
  Logger,
} from '@memnox/core';
import { DECISION_EFFECT, isLeaseLive, leaseExpiry, scopeSatisfies } from '@memnox/core';
import type { ActionGateway } from './action-gateway';

export const LEASE_ACTION_PREFIX = 'capability.issue';

export const LEASE_REFUSAL = {
  UNKNOWN_CAPABILITY: 'no such capability',
  NOT_YOURS: 'that capability belongs to another agent',
  OUT_OF_SCOPE: 'the requested scope is wider than the capability allows',
} as const;

export interface LeaseRequest {
  capabilityId: string;
  target: string;
  scope: Record<string, string>;
  environment?: string;
  sessionId?: string;
}

export type LeaseOutcome =
  { issued: true; lease: Lease } | { issued: false; reason: string; decisionId?: string };

export interface CapabilityBrokerDeps {
  capabilities: CapabilityStore;
  leases: LeaseStore;
  gateway: ActionGateway;
  logger: Logger;
  /** Injected so a lease's window is reproducible in a test. */
  clock?: () => Date;
}

/**
 * Ask by operation, not by secret. Every issue runs the ordinary decision path first,
 * so the ledger holds why an agent held a credential and for how long, and a refusal
 * to issue is an ordinary verdict rather than a special case.
 */
export class CapabilityBroker {
  private readonly clock: () => Date;

  constructor(private readonly deps: CapabilityBrokerDeps) {
    this.clock = deps.clock ?? (() => new Date());
  }

  async issue(agentToken: string, request: LeaseRequest): Promise<LeaseOutcome> {
    const capability = await this.deps.capabilities.findById(request.capabilityId);
    if (capability === null) {
      return { issued: false, reason: LEASE_REFUSAL.UNKNOWN_CAPABILITY };
    }
    if (!scopeSatisfies(capability, request.scope)) {
      return { issued: false, reason: LEASE_REFUSAL.OUT_OF_SCOPE };
    }

    const action: ActionRequest = {
      action: `${LEASE_ACTION_PREFIX}.${capability.operation}`,
      target: request.target,
      ...(request.environment === undefined ? {} : { environment: request.environment }),
      ...(request.sessionId === undefined ? {} : { sessionId: request.sessionId }),
    };
    const decision = await this.deps.gateway.authorize(agentToken, action);
    if (decision.effect !== DECISION_EFFECT.ALLOW) {
      return { issued: false, reason: decision.reason, decisionId: decision.eventId };
    }

    const agent = await this.deps.gateway.agents.resolveByToken(agentToken);
    if (agent === null) {
      // The gateway already refused an unknown caller, so this is a broken invariant.
      this.deps.logger.error('capability issued to a token the registry cannot resolve');
      return { issued: false, reason: LEASE_REFUSAL.NOT_YOURS };
    }
    if (capability.agentId !== agent.id) {
      return {
        issued: false,
        reason: LEASE_REFUSAL.NOT_YOURS,
        decisionId: decision.eventId,
      };
    }

    const issuedAt = this.clock();
    const lease: Lease = {
      id: randomUUID(),
      capabilityId: capability.id,
      agentId: agent.id,
      decisionId: decision.eventId,
      target: request.target,
      issuedAt: issuedAt.toISOString(),
      expiresAt: leaseExpiry(capability, issuedAt),
      usedCount: 0,
    };
    await this.deps.leases.save(lease);
    return { issued: true, lease };
  }

  /** Expiry belongs to the issuer, so a holder asking about a dead lease is told no. */
  async redeem(leaseId: string): Promise<Lease | null> {
    const lease = await this.deps.leases.findById(leaseId);
    if (lease === null) return null;
    if (!isLeaseLive(lease, this.clock())) return null;
    const used: Lease = { ...lease, usedCount: lease.usedCount + 1 };
    await this.deps.leases.save(used);
    return used;
  }

  /** Part of kill: revoking leases is the half of stopping an agent that actually bites. */
  async revokeAllFor(agentId: string): Promise<number> {
    return this.deps.leases.revokeAllFor(agentId, this.clock().toISOString());
  }

  async grant(capability: Capability): Promise<void> {
    await this.deps.capabilities.save(capability);
  }
}
