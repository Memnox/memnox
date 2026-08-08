import { describe, expect, it } from 'vitest';
import { EMPTY_AGENT_STATS, type AgentIdentity } from '@memnox/core';
import type { AuthorityGrant, AuthorityStore } from '@memnox/org-graph';
import { AUTHORITY_ADVISOR, AuthorityAdvisor } from '../src/authority-advisor';

const NOW = new Date('2026-06-01T12:00:00.000Z');

const agent = (over: Partial<AgentIdentity> = {}): AgentIdentity => ({
  id: 'agent-1',
  name: 'assistant',
  kind: 'custom',
  status: 'active',
  tokenHash: 'hash',
  createdAt: '2026-01-01T00:00:00.000Z',
  stats: EMPTY_AGENT_STATS,
  ...over,
});

class StubGrants implements AuthorityStore {
  constructor(private readonly grants: AuthorityGrant[]) {}
  async save(): Promise<void> {}
  async list(workspaceId: string): Promise<AuthorityGrant[]> {
    return this.grants.filter((grant) => grant.workspaceId === workspaceId);
  }
  async remove(): Promise<boolean> {
    return false;
  }
}

const grant = (over: Partial<AuthorityGrant> = {}): AuthorityGrant => ({
  id: 'grant-1',
  workspaceId: 'default',
  principal: 'alice',
  actions: ['expense.approve'],
  limit: 5_000,
  grantedBy: 'alice',
  grantedAt: '2026-01-01T00:00:00.000Z',
  ...over,
});

const advise = (
  grants: AuthorityGrant[],
  request: { action: string; principal?: string; amount?: number },
  identity = agent(),
): ReturnType<AuthorityAdvisor['advise']> =>
  new AuthorityAdvisor(new StubGrants(grants), () => NOW).advise(request, {
    agent: identity,
  });

describe('AuthorityAdvisor', () => {
  it('says nothing when nothing is delegated', async () => {
    expect(await advise([], { action: 'expense.approve', amount: 9_000 })).toEqual([]);
  });

  it('says nothing about an action under the ceiling', async () => {
    const advisories = await advise([grant()], {
      action: 'expense.approve',
      principal: 'alice',
      amount: 4_000,
    });

    expect(advisories).toEqual([]);
  });

  it('escalates past the ceiling, and only ever escalates', async () => {
    const [advisory] = await advise([grant()], {
      action: 'expense.approve',
      principal: 'alice',
      amount: 9_000,
    });

    expect(advisory?.source).toBe(AUTHORITY_ADVISOR);
    expect(advisory?.escalateTo).toBe('require_approval');
    expect(advisory?.approvers).toContain('alice');
    expect(advisory?.signals).toEqual(['authority:over-ceiling']);
  });

  it('reads grants from the agent’s own workspace only', async () => {
    const elsewhere = [grant({ workspaceId: 'somebody-else' })];

    expect(
      await advise(elsewhere, {
        action: 'expense.approve',
        principal: 'alice',
        amount: 9_000,
      }),
    ).toEqual([]);
  });

  it('scopes to the agent’s workspace when the agent has one', async () => {
    const advisories = await advise(
      [grant({ workspaceId: 'acme' })],
      { action: 'expense.approve', principal: 'alice', amount: 9_000 },
      agent({ orgId: 'acme' }),
    );

    expect(advisories).toHaveLength(1);
  });

  it('escalates once a temporary delegation has lapsed', async () => {
    const [advisory] = await advise([grant({ expiresAt: '2026-06-01T11:00:00.000Z' })], {
      action: 'expense.approve',
      principal: 'alice',
      amount: 10,
    });

    expect(advisory?.signals).toEqual(['authority:expired']);
  });

  it('never returns an advisory that could loosen a decision', async () => {
    const advisories = await advise([grant({ overLimit: 'block' })], {
      action: 'expense.approve',
      principal: 'alice',
      amount: 9_000,
    });

    for (const advisory of advisories) {
      expect(['block', 'require_approval']).toContain(advisory.escalateTo);
    }
  });
});
