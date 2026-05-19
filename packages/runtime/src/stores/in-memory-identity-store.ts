import type { AgentIdentity, IdentityStore } from '@memnox/core';

export class InMemoryIdentityStore implements IdentityStore {
  private readonly agents = new Map<string, AgentIdentity>();

  async save(agent: AgentIdentity): Promise<void> {
    this.agents.set(agent.id, agent);
  }

  async findById(id: string): Promise<AgentIdentity | null> {
    return this.agents.get(id) ?? null;
  }

  async findByTokenHash(tokenHash: string): Promise<AgentIdentity | null> {
    for (const agent of this.agents.values()) {
      if (agent.tokenHash === tokenHash) return agent;
    }
    return null;
  }

  async list(): Promise<AgentIdentity[]> {
    return [...this.agents.values()];
  }
}
