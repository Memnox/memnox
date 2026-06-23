import { describe, expect, it } from 'vitest';
import { DECISION_EFFECT, RISK_LEVEL } from '@memnox/core';
import { FakeRuntime, runCli } from './cli-harness';

const CHECK_PATH = '/v1/actions/check';

const decision = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  effect: DECISION_EFFECT.BLOCK,
  riskLevel: RISK_LEVEL.CRITICAL,
  reason: 'No AI-initiated destructive database operations in production',
  matchedPolicies: [{ name: 'production-database-protection' }],
  ...over,
});

describe('memnox check', () => {
  it('prints the effect, risk, reason, and matched policies', async () => {
    const runtime = new FakeRuntime().on('POST', CHECK_PATH, decision());

    const { out } = await runCli(
      [
        'check',
        '--token',
        'mnx_test',
        '--action',
        'database.delete',
        '--target',
        'users',
        '--env',
        'production',
      ],
      runtime,
    );

    expect(out.text).toContain('Decision : BLOCK');
    expect(out.text).toContain(`Risk     : ${RISK_LEVEL.CRITICAL}`);
    expect(out.text).toContain('No AI-initiated destructive database operations');
    expect(out.text).toContain('Policies : production-database-protection');
  });

  it('sends the action, target, and environment the flags describe', async () => {
    const runtime = new FakeRuntime().on('POST', CHECK_PATH, decision());

    await runCli(
      [
        'check',
        '--token',
        'mnx_test',
        '--action',
        'deploy.production',
        '--target',
        'api',
        '--env',
        'production',
        '--session',
        'sess-1',
      ],
      runtime,
    );

    expect(runtime.requests).toHaveLength(1);
    expect(runtime.requests[0]?.body).toMatchObject({
      action: 'deploy.production',
      target: 'api',
      environment: 'production',
      sessionId: 'sess-1',
    });
  });

  it('authenticates with the agent token, not an admin token', async () => {
    const runtime = new FakeRuntime().on('POST', CHECK_PATH, decision());

    await runCli(['check', '--token', 'mnx_agent', '--action', 'file.read'], runtime);

    expect(runtime.requests[0]?.authorization).toBe('Bearer mnx_agent');
  });

  it('surfaces the approval id when one is raised', async () => {
    const runtime = new FakeRuntime().on(
      'POST',
      CHECK_PATH,
      decision({
        effect: DECISION_EFFECT.REQUIRE_APPROVAL,
        approvalId: 'apr_42',
        matchedPolicies: [],
      }),
    );

    const { out } = await runCli(
      ['check', '--token', 'mnx_test', '--action', 'deploy.production'],
      runtime,
    );

    expect(out.text).toContain('Decision : REQUIRE_APPROVAL');
    expect(out.text).toContain('Approval : apr_42');
    expect(out.text).not.toContain('Policies :');
  });

  it('fails loudly when the runtime rejects the request', async () => {
    const runtime = new FakeRuntime().on('POST', CHECK_PATH, { error: 'bad token' }, 401);

    await expect(
      runCli(['check', '--token', 'nope', '--action', 'file.read'], runtime),
    ).rejects.toThrow(/401|failed/i);
  });
});
