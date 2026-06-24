import { describe, expect, it } from 'vitest';
import { APPROVAL_STATUS } from '@memnox/core';
import { FakeRuntime, runCli } from './cli-harness';

const APPROVALS_PATH = '/v1/approvals';

const approval = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'apr_1',
  action: 'deploy.production',
  target: 'api',
  environment: 'production',
  approvers: ['eng-lead', 'security-team'],
  minApprovals: 1,
  grants: [],
  status: APPROVAL_STATUS.PENDING,
  ...over,
});

describe('memnox approvals list', () => {
  it('lists each pending approval with its approvers', async () => {
    const runtime = new FakeRuntime().on('GET', APPROVALS_PATH, [approval()]);

    const { out } = await runCli(['approvals', 'list'], runtime);

    expect(out.text).toContain('apr_1  deploy.production api [production]');
    expect(out.text).toContain('approvers: eng-lead, security-team');
  });

  it('omits the target and environment when the approval has neither', async () => {
    const runtime = new FakeRuntime().on('GET', APPROVALS_PATH, [
      approval({ target: undefined, environment: undefined }),
    ]);

    const { out } = await runCli(['approvals', 'list'], runtime);

    expect(out.text).toContain('apr_1  deploy.production —');
    expect(out.text).not.toContain('[');
  });

  it('says so plainly when nothing is pending', async () => {
    const runtime = new FakeRuntime().on('GET', APPROVALS_PATH, []);

    const { out } = await runCli(['approvals', 'list'], runtime);

    expect(out.text).toBe('No pending approvals.');
  });
});

describe('memnox approvals resolve', () => {
  it('approves by default and records who resolved it', async () => {
    const runtime = new FakeRuntime().on(
      'POST',
      `${APPROVALS_PATH}/apr_1`,
      approval({ status: APPROVAL_STATUS.APPROVED, resolvedBy: 'dana' }),
    );

    const { out } = await runCli(
      ['approvals', 'resolve', 'apr_1', '--by', 'dana'],
      runtime,
    );

    expect(runtime.requests[0]?.body).toEqual({ approved: true, resolvedBy: 'dana' });
    expect(out.text).toContain(`apr_1: ${APPROVAL_STATUS.APPROVED} by dana`);
  });

  it('denies when --deny is passed', async () => {
    const runtime = new FakeRuntime().on(
      'POST',
      `${APPROVALS_PATH}/apr_1`,
      approval({ status: APPROVAL_STATUS.DENIED, resolvedBy: 'dana' }),
    );

    await runCli(['approvals', 'resolve', 'apr_1', '--by', 'dana', '--deny'], runtime);

    expect(runtime.requests[0]?.body).toEqual({ approved: false, resolvedBy: 'dana' });
  });
});

describe('memnox approvals override', () => {
  it('requires a reason and labels the result as an override', async () => {
    const runtime = new FakeRuntime().on(
      'POST',
      `${APPROVALS_PATH}/apr_1/override`,
      approval({ status: APPROVAL_STATUS.APPROVED, resolvedBy: 'admin' }),
    );

    const { out } = await runCli(
      ['approvals', 'override', 'apr_1', '--reason', 'sev1 incident'],
      runtime,
    );

    expect(runtime.requests[0]?.body).toEqual({ reason: 'sev1 incident' });
    expect(out.text).toContain('(override)');
  });
});

describe('memnox approvals status', () => {
  it('shows how many grants are in and how many are still needed', async () => {
    const runtime = new FakeRuntime().on(
      'GET',
      `${APPROVALS_PATH}/apr_1`,
      approval({ minApprovals: 2, grants: [{ by: 'dana', at: 'now' }] }),
    );

    const { out } = await runCli(['approvals', 'status', 'apr_1'], runtime);

    expect(out.text).toContain('Approval : apr_1');
    expect(out.text).toContain('Action   : deploy.production api [production]');
    expect(out.text).toContain(`Status   : ${APPROVAL_STATUS.PENDING}`);
    expect(out.text).toContain('Granted  : 1/2 (dana)');
  });

  it('reports who resolved it and whether it was an override', async () => {
    const runtime = new FakeRuntime().on(
      'GET',
      `${APPROVALS_PATH}/apr_1`,
      approval({
        status: APPROVAL_STATUS.APPROVED,
        resolvedBy: 'admin',
        override: true,
        grants: [],
      }),
    );

    const { out } = await runCli(['approvals', 'status', 'apr_1'], runtime);

    expect(out.text).toContain('Resolved : by admin (override)');
    expect(out.text).toContain('Granted  : 0/1');
  });
});
