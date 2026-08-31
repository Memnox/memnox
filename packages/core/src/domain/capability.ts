/**
 * Nothing long lived is handed to an agent. The broker exchanges a request for a lease
 * scoped to one operation, one resource and a few minutes, and expiry belongs to the
 * issuer rather than to the agent's good behaviour.
 */
export interface Capability {
  id: string;
  agentId: string;
  /** Asked for by operation, never by secret: "refund.create", not "the payments key". */
  operation: string;
  scope: Record<string, string>;
  ttlSeconds: number;
  /** The rule that permits issuing it, so a lease is always traceable to a decision. */
  policyId?: string;
}

export interface Lease {
  id: string;
  capabilityId: string;
  agentId: string;
  /** Every lease is a decision, so the ledger holds why a credential was held. */
  decisionId: string;
  target: string;
  issuedAt: string;
  expiresAt: string;
  revokedAt?: string;
  usedCount: number;
}

export const LEASE_MAX_TTL_SECONDS = 15 * 60;
export const LEASE_DEFAULT_TTL_SECONDS = 5 * 60;

/** A lease past its expiry is dead whatever the holder believes; the issuer decides. */
export function isLeaseLive(lease: Lease, now: Date): boolean {
  if (lease.revokedAt !== undefined) return false;
  return Date.parse(lease.expiresAt) > now.getTime();
}

/** A ceiling, not a suggestion: a capability cannot ask for longer than the maximum. */
export function effectiveTtlSeconds(capability: Capability): number {
  if (capability.ttlSeconds <= 0) return LEASE_DEFAULT_TTL_SECONDS;
  return Math.min(capability.ttlSeconds, LEASE_MAX_TTL_SECONDS);
}

export function leaseExpiry(capability: Capability, issuedAt: Date): string {
  return new Date(
    issuedAt.getTime() + effectiveTtlSeconds(capability) * 1000,
  ).toISOString();
}

/** A scope narrows; it never widens. Every key the capability names must be satisfied. */
export function scopeSatisfies(
  capability: Capability,
  requested: Readonly<Record<string, string>>,
): boolean {
  for (const [key, value] of Object.entries(capability.scope)) {
    if (requested[key] !== value) return false;
  }
  return true;
}

export interface CapabilityStore {
  save(capability: Capability): Promise<void>;
  findById(id: string): Promise<Capability | null>;
  listByAgent(agentId: string): Promise<Capability[]>;
}

export interface LeaseStore {
  save(lease: Lease): Promise<void>;
  findById(id: string): Promise<Lease | null>;
  listByAgent(agentId: string): Promise<Lease[]>;
  /** Kill revokes every live lease an agent holds, in one recorded action. */
  revokeAllFor(agentId: string, at: string): Promise<number>;
}
