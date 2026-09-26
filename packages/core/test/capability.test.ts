import { describe, expect, it } from 'vitest';
import { capabilityOf } from '../src/domain/capability';
import { LocalGate } from '../src/gate/local-gate';

describe('what a change does, finer than its class', () => {
  it.each([
    ['mcp.stripe.create_refund', 'write', 'transfer'],
    ['stripe.refunds-create', 'write', 'transfer'],
    ['stripe.payment_intents-confirm', 'write', 'transfer'],
    ['mcp.railway.redeploy', 'write', 'deploy'],
    ['railway.up', 'write', 'deploy'],
    ['vercel.deploy-prod', 'write', 'deploy'],
    ['kubectl.apply', 'write', 'deploy'],
    ['terraform.apply', 'write', 'deploy'],
    ['gh.secret-set', 'write', 'admin'],
    ['aws.iam', 'write', 'admin'],
    ['kubectl.exec', 'write', 'execute'],
    ['mcp.railway.delete_service', 'destructive', 'delete'],
    ['mcp.slack.send_message', 'communication', 'send'],
    ['gh.pr-merge', 'write', 'write'],
    ['mcp.railway.list_deployments', 'read', 'read'],
    ['git.apply', 'write', 'write'],
    ['mcp.x.frob', 'unknown', 'unknown'],
  ])('%s (%s) is %s', (action, toolClass, expected) => {
    expect(capabilityOf(action, toolClass)).toBe(expected);
  });

  it('is what a rule can name', () => {
    const gate = new LocalGate(
      [
        {
          name: 'no-money',
          match: { actions: ['*'], capabilities: ['transfer', 'deploy'] },
          decision: { effect: 'deny', reason: 'money and deploys are people work' },
        },
      ] as never,
      { agentName: 'agent' },
    );
    expect(
      gate.evaluate({ action: 'mcp.stripe.create_refund', toolClass: 'write' }).effect,
    ).toBe('deny');
    expect(gate.evaluate({ action: 'gh.pr-create', toolClass: 'write' }).effect).toBe(
      'allow',
    );
  });
});
