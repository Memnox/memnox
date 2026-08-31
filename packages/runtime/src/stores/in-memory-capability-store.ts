import type { Capability, CapabilityStore, Lease, LeaseStore } from '@memnox/core';
import { isLeaseLive } from '@memnox/core';

export class InMemoryCapabilityStore implements CapabilityStore {
  private readonly byId = new Map<string, Capability>();

  async save(capability: Capability): Promise<void> {
    this.byId.set(capability.id, capability);
  }

  async findById(id: string): Promise<Capability | null> {
    return this.byId.get(id) ?? null;
  }

  async listByAgent(agentId: string): Promise<Capability[]> {
    return [...this.byId.values()].filter((each) => each.agentId === agentId);
  }
}

export class InMemoryLeaseStore implements LeaseStore {
  private readonly byId = new Map<string, Lease>();

  async save(lease: Lease): Promise<void> {
    this.byId.set(lease.id, lease);
  }

  async findById(id: string): Promise<Lease | null> {
    return this.byId.get(id) ?? null;
  }

  async listByAgent(agentId: string): Promise<Lease[]> {
    return [...this.byId.values()].filter((each) => each.agentId === agentId);
  }

  async revokeAllFor(agentId: string, at: string): Promise<number> {
    const now = new Date(at);
    let revoked = 0;
    for (const lease of this.byId.values()) {
      if (lease.agentId !== agentId) continue;
      if (!isLeaseLive(lease, now)) continue;
      this.byId.set(lease.id, { ...lease, revokedAt: at });
      revoked += 1;
    }
    return revoked;
  }
}
