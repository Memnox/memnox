import { describe, expect, it } from 'vitest';
import { AGENT_KIND, AGENT_STATUS, EMPTY_AGENT_STATS } from '@memnox/core';
import type { AgentIdentity } from '@memnox/core';
import { resolveAgentFromClientCert } from '../src/client-cert';
import { InMemoryIdentityStore } from '../src/stores/in-memory-identity-store';

function agent(name: string): AgentIdentity {
  return {
    id: `id-${name}`,
    name,
    kind: AGENT_KIND.CUSTOM,
    status: AGENT_STATUS.ACTIVE,
    tokenHash: `hash-${name}`,
    createdAt: new Date().toISOString(),
    stats: { ...EMPTY_AGENT_STATS },
  };
}

async function storeWith(...agents: AgentIdentity[]): Promise<InMemoryIdentityStore> {
  const store = new InMemoryIdentityStore();
  for (const entry of agents) await store.save(entry);
  return store;
}

describe('resolveAgentFromClientCert', () => {
  it('maps the certificate subject CN to the agent with that name', async () => {
    const store = await storeWith(agent('claude-code'), agent('cursor'));
    const resolved = await resolveAgentFromClientCert(
      { subject: { CN: 'claude-code' } },
      store,
    );
    expect(resolved?.name).toBe('claude-code');
    expect(resolved?.id).toBe('id-claude-code');
  });

  it('returns null when no agent matches the CN', async () => {
    const store = await storeWith(agent('claude-code'));
    const resolved = await resolveAgentFromClientCert(
      { subject: { CN: 'imposter' } },
      store,
    );
    expect(resolved).toBeNull();
  });

  it('returns null for a missing certificate or subject CN', async () => {
    const store = await storeWith(agent('claude-code'));
    expect(await resolveAgentFromClientCert(null, store)).toBeNull();
    expect(await resolveAgentFromClientCert({}, store)).toBeNull();
    expect(await resolveAgentFromClientCert({ subject: {} }, store)).toBeNull();
  });
});
