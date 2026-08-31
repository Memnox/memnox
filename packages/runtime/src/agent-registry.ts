import { randomUUID } from 'node:crypto';
import type { AgentIdentity, AgentKind, AgentStatus, IdentityStore } from '@memnox/core';
import { AGENT_STATUS, EMPTY_AGENT_STATS } from '@memnox/core';
import { verifyAgentJwt, type AgentJwtConfig } from './agent-jwt';
import { generateAgentToken, hashToken } from './token';

export interface AgentRegistration {
  agent: AgentIdentity;
  /** Shown once — only the hash is stored. */
  token: string;
}

/** Agent identity: who exists, what they may attempt, and which credential proves it. */
export class AgentRegistry {
  constructor(
    private readonly store: IdentityStore,
    private readonly agentJwt?: AgentJwtConfig,
  ) {}

  async register(
    name: string,
    kind: AgentKind,
    capabilities?: string[],
    orgId?: string,
  ): Promise<AgentRegistration> {
    const token = generateAgentToken();
    const agent: AgentIdentity = {
      id: randomUUID(),
      name,
      kind,
      status: AGENT_STATUS.ACTIVE,
      tokenHash: hashToken(token),
      createdAt: new Date().toISOString(),
      stats: { ...EMPTY_AGENT_STATS },
      ...(capabilities && capabilities.length > 0 ? { capabilities } : {}),
      ...(orgId ? { orgId } : {}),
    };
    await this.store.save(agent);
    return { agent, token };
  }

  /** The old token stops working the moment this returns. */
  async rotate(agentId: string): Promise<AgentRegistration | null> {
    const agent = await this.store.findById(agentId);
    if (!agent) return null;
    const token = generateAgentToken();
    const rotated: AgentIdentity = {
      ...agent,
      tokenHash: hashToken(token),
      rotatedAt: new Date().toISOString(),
    };
    await this.store.save(rotated);
    return { agent: rotated, token };
  }

  async setStatus(agentId: string, status: AgentStatus): Promise<AgentIdentity | null> {
    const agent = await this.store.findById(agentId);
    if (!agent) return null;
    const updated = { ...agent, status };
    await this.store.save(updated);
    return updated;
  }

  /**
   * Who answers for this agent. Every later escalation resolves through this edge, and
   * an agent with no named owner is exactly what the census counts as unmanaged.
   */
  async setOwner(agentId: string, owner: string): Promise<AgentIdentity | null> {
    const agent = await this.store.findById(agentId);
    if (!agent) return null;
    const updated = { ...agent, owner };
    await this.store.save(updated);
    return updated;
  }

  /** Bearer token first, then a service-account JWT when one is configured. */
  async resolveByToken(token: string): Promise<AgentIdentity | null> {
    const byHash = await this.store.findByTokenHash(hashToken(token));
    if (byHash) return byHash;
    if (this.agentJwt) {
      const agentId = verifyAgentJwt(token, this.agentJwt);
      if (agentId) return this.store.findById(agentId);
    }
    return null;
  }

  list(): Promise<AgentIdentity[]> {
    return this.store.list();
  }

  findById(agentId: string): Promise<AgentIdentity | null> {
    return this.store.findById(agentId);
  }

  async recordDecisionStats(
    agent: AgentIdentity,
    stats: AgentIdentity['stats'],
  ): Promise<void> {
    await this.store.save({ ...agent, stats });
  }
}
