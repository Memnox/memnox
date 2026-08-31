import { beforeEach, describe, expect, it } from 'vitest';
import { AGENT_KIND } from '@memnox/core';
import { PolicyEngine } from '@memnox/policy-engine';
import { ActionGateway } from '../src/action-gateway';
import { InMemoryApprovalStore } from '../src/stores/in-memory-approval-store';
import { InMemoryAuditLog } from '../src/stores/in-memory-audit-log';
import { InMemoryIdentityStore } from '../src/stores/in-memory-identity-store';

describe('naming who answers for an agent', () => {
  let gateway: ActionGateway;
  let agentId: string;

  beforeEach(async () => {
    gateway = new ActionGateway({
      identityStore: new InMemoryIdentityStore(),
      auditLog: new InMemoryAuditLog(),
      approvalStore: new InMemoryApprovalStore(),
      policyEngine: new PolicyEngine([]),
    });
    agentId = (await gateway.registerAgent('release-bot', AGENT_KIND.CUSTOM)).agent.id;
  });

  it('records the owner, which is the edge every escalation resolves through', async () => {
    const updated = await gateway.agents.setOwner(agentId, 'moise');

    expect(updated?.owner).toBe('moise');
  });

  it('survives a re-read, rather than living only in the reply', async () => {
    await gateway.agents.setOwner(agentId, 'moise');

    const stored = await gateway.agents.findById(agentId);
    expect(stored?.owner).toBe('moise');
  });

  it('answers nothing for an agent that does not exist', async () => {
    expect(await gateway.agents.setOwner('nope', 'moise')).toBeNull();
  });
});
