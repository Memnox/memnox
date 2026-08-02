import { describe, expect, it } from 'vitest';
import { APPROVAL_STATUS, type ApprovalFlowSummary } from '@memnox/core';
import { FakeRuntime, runCli } from './cli-harness';

const APPROVALS_PATH = '/v1/approvals';
const HEALTH_PATH = '/v1/approvals/health';

const health = (over: Partial<ApprovalFlowSummary> = {}): ApprovalFlowSummary => ({
  total: 8,
  pending: 2,
  approved: 4,
  denied: 1,
  lapsed: 1,
  overrides: 1,
  medianResolveMinutes: 45,
  p90ResolveMinutes: 180,
  oldestPendingMinutes: 2_880,
  approverActivity: [{ approver: 'alice', grants: 4 }],
  ...over,
});

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

describe('memnox approvals health', () => {
  it('reports where approvals stall', async () => {
    const runtime = new FakeRuntime().on('GET', HEALTH_PATH, health());

    const { out } = await runCli(['approvals', 'health'], runtime);

    expect(out.text).toContain('Pending        : 2');
    expect(out.text).toContain('Lapsed unread  : 1');
    expect(out.text).toContain('Break-glass    : 1');
    expect(out.text).toContain('Median resolve : 45m');
    expect(out.text).toContain('p90 resolve    : 3h');
    expect(out.text).toContain('Oldest pending : 2d');
    expect(out.text).toContain('- alice (4)');
  });

  it('shows an em dash when nothing has been resolved yet', async () => {
    const runtime = new FakeRuntime().on(
      'GET',
      HEALTH_PATH,
      health({ medianResolveMinutes: null, p90ResolveMinutes: null }),
    );

    const { out } = await runCli(['approvals', 'health'], runtime);

    // Never "0m" — that would claim the approvals resolved instantly.
    expect(out.text).toContain('Median resolve : —');
    expect(out.text).toContain('p90 resolve    : —');
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
