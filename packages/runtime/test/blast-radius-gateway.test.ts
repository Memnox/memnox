import { describe, expect, it } from 'vitest';
import { AGENT_KIND, DECISION_EFFECT } from '@memnox/core';
import { BlastRadiusAdvisor, CodeGraph } from '@memnox/code-graph';
import { PolicyEngine } from '@memnox/policy-engine';
import { ActionGateway } from '../src/action-gateway';
import { InMemoryApprovalStore } from '../src/stores/in-memory-approval-store';
import { InMemoryAuditLog } from '../src/stores/in-memory-audit-log';
import { InMemoryIdentityStore } from '../src/stores/in-memory-identity-store';

/** money.ts looks harmless; payment/checkout.ts is what makes editing it sensitive. */
const GRAPH = CodeGraph.build([
  { path: 'src/utils/money.ts', content: '' },
  { path: 'src/payment/checkout.ts', content: "import '../utils/money';" },
  { path: 'src/blog/post.ts', content: '' },
]);

function buildGateway(auditLog: InMemoryAuditLog): ActionGateway {
  return new ActionGateway({
    identityStore: new InMemoryIdentityStore(),
    auditLog,
    approvalStore: new InMemoryApprovalStore(),
    policyEngine: new PolicyEngine([]),
    advisors: [
      new BlastRadiusAdvisor(GRAPH, {
        protectedPaths: ['*payment/*'],
        approvers: ['security-team'],
      }),
    ],
  });
}

describe('blast radius through the gateway', () => {
  it('turns an allowed helper edit into an approval because payment code imports it', async () => {
    const auditLog = new InMemoryAuditLog();
    const gateway = buildGateway(auditLog);
    const { token } = await gateway.registerAgent('claude-code', AGENT_KIND.CLAUDE_CODE);

    const decision = await gateway.authorize(token, {
      action: 'code.modify',
      target: 'src/utils/money.ts',
    });

    expect(decision.effect).toBe(DECISION_EFFECT.REQUIRE_APPROVAL);
    expect(decision.reason).toContain('src/payment/checkout.ts');

    const [event] = await auditLog.recent(1);
    expect(event?.advisories.join()).toContain('blast-radius');
  });

  it('leaves an unrelated file allowed', async () => {
    const auditLog = new InMemoryAuditLog();
    const gateway = buildGateway(auditLog);
    const { token } = await gateway.registerAgent('claude-code', AGENT_KIND.CLAUDE_CODE);

    const decision = await gateway.authorize(token, {
      action: 'code.modify',
      target: 'src/blog/post.ts',
    });

    expect(decision.effect).toBe(DECISION_EFFECT.ALLOW);
  });
});
