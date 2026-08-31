import { describe, expect, it } from 'vitest';
import { APPROVAL_STATUS, DECISION_EFFECT, RISK_LEVEL } from '@memnox/core';
import { resolveWhoAmI } from '../src/whoami';
import { FakeRuntime, runCli } from './cli-harness';

const APPROVALS_PATH = '/v1/approvals';
const CHECK_PATH = '/v1/actions/check';
const AUDIT_PATH = '/v1/audit';
const POLICIES_PATH = '/v1/policies';

const approval = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'apr_42',
  action: 'deploy.service',
  target: 'api',
  approvers: ['eng-lead'],
  grants: [],
  minApprovals: 1,
  status: APPROVAL_STATUS.PENDING,
  ...over,
});

describe('resolveWhoAmI', () => {
  it('prefers an explicit MEMNOX_USER', () => {
    expect(resolveWhoAmI({ MEMNOX_USER: 'dana', USER: 'root' })).toBe('dana');
  });

  it('falls back through the usual shell variables', () => {
    expect(resolveWhoAmI({ USER: 'dana' })).toBe('dana');
    expect(resolveWhoAmI({ LOGNAME: 'dana' })).toBe('dana');
    expect(resolveWhoAmI({ USERNAME: 'dana' })).toBe('dana');
  });

  it('never returns an empty name', () => {
    expect(resolveWhoAmI({ USER: '   ' })).toBe('unknown');
    expect(resolveWhoAmI({})).toBe('unknown');
  });
});

describe('memnox approve / deny', () => {
  it('grants without making the user name themselves', async () => {
    const runtime = new FakeRuntime().on(
      'POST',
      `${APPROVALS_PATH}/apr_42`,
      approval({ status: APPROVAL_STATUS.APPROVED, resolvedBy: 'dana' }),
    );

    const { out } = await runCli(['approve', 'apr_42', '--by', 'dana'], runtime);

    expect(runtime.requests[0]?.body).toMatchObject({
      approved: true,
      resolvedBy: 'dana',
    });
    expect(out.text).toContain('approved by dana');
  });

  it('denies through the same path with approved false', async () => {
    const runtime = new FakeRuntime().on(
      'POST',
      `${APPROVALS_PATH}/apr_42`,
      approval({ status: APPROVAL_STATUS.DENIED, resolvedBy: 'dana' }),
    );

    await runCli(['deny', 'apr_42', '--by', 'dana'], runtime);

    expect(runtime.requests[0]?.body).toMatchObject({ approved: false });
  });

  it('resolves the approver from the environment when --by is absent', async () => {
    const runtime = new FakeRuntime().on(
      'POST',
      `${APPROVALS_PATH}/apr_42`,
      approval({ status: APPROVAL_STATUS.APPROVED, resolvedBy: 'whoever' }),
    );

    await runCli(['approve', 'apr_42'], runtime);

    const body = runtime.requests[0]?.body as { resolvedBy?: string };
    expect(body.resolvedBy).toBeTruthy();
  });
});

describe('memnox approvals', () => {
  it('lists pending approvals with no subcommand', async () => {
    const runtime = new FakeRuntime().on('GET', APPROVALS_PATH, [approval()]);

    const { out } = await runCli(['approvals'], runtime);

    expect(out.text).toContain('apr_42');
    expect(out.text).toContain('deploy.service');
  });

  it('still lists them under the explicit subcommand', async () => {
    const runtime = new FakeRuntime().on('GET', APPROVALS_PATH, [approval()]);

    const { out } = await runCli(['approvals', 'list'], runtime);

    expect(out.text).toContain('apr_42');
  });
});

describe('memnox check positional form', () => {
  it('reads the action and target as arguments', async () => {
    const runtime = new FakeRuntime().on('POST', CHECK_PATH, {
      effect: DECISION_EFFECT.WITHHOLD,
      riskLevel: RISK_LEVEL.HIGH,
      reason: 'withheld',
      matchedPolicies: [],
    });

    await runCli(['check', 'shell.execute', 'rm -rf /', '--token', 'mnx_t'], runtime);

    expect(runtime.requests[0]?.body).toMatchObject({
      action: 'shell.execute',
      target: 'rm -rf /',
    });
  });

  it('asks for an action instead of printing usage', async () => {
    await expect(runCli(['check', '--token', 'mnx_t'])).rejects.toThrow(/memnox check/);
  });
});

describe('memnox reload', () => {
  it('replaces the curl call people were told to run', async () => {
    const runtime = new FakeRuntime().on('POST', `${POLICIES_PATH}/reload`, {
      reloaded: true,
      version: 'abc123',
    });

    const { out } = await runCli(['reload'], runtime);

    expect(out.text).toContain('abc123');
  });
});

describe('memnox status', () => {
  it('answers is-it-on in one call', async () => {
    const runtime = new FakeRuntime()
      .on('GET', POLICIES_PATH, {
        policies: [{ name: 'a' }, { name: 'b' }],
        version: 'v1',
      })
      .on('GET', APPROVALS_PATH, [approval()])
      .on('GET', AUDIT_PATH, [
        { action: 'file.write', effect: DECISION_EFFECT.ALLOW, agentName: 'x' },
        {
          action: 'shell.execute',
          effect: DECISION_EFFECT.ALLOW,
          shadowEffect: DECISION_EFFECT.WITHHOLD,
          agentName: 'x',
        },
      ]);

    const { out } = await runCli(['status'], runtime);

    expect(out.text).toContain('Policies  : 2 (version v1)');
    expect(out.text).toContain('Waiting   : 1 approval(s)');
    // The number that says whether enforcing is safe yet.
    expect(out.text).toContain('Observed  : 1 would have been stopped if enforcing');
  });
});
