import { describe, expect, it } from 'vitest';
import { FakeRuntime, runCli } from './cli-harness';

const APPROVAL_ID = 'apr_1';
const STATUS_PATH = `/v1/approvals/${APPROVAL_ID}`;

const approval = (grantors: string[]): Record<string, unknown> => ({
  id: APPROVAL_ID,
  action: 'code.modify',
  target: 'payment/charge.ts',
  status: 'approved',
  approvers: ['security-team'],
  minApprovals: 1,
  grants: grantors.map((by) => ({ by, at: '2026-08-07T00:00:00.000Z' })),
  createdAt: '2026-08-07T00:00:00.000Z',
  requestFingerprint: 'fp',
});

describe('memnox approvals status', () => {
  it('names a grantor who matched no listed approver', async () => {
    const runtime = new FakeRuntime().on('GET', STATUS_PATH, approval(['random-person']));

    const { out } = await runCli(['approvals', 'status', APPROVAL_ID], runtime);

    // `approvers` names groups and grants name individuals, so membership
    // cannot be enforced here — but it can be made visible.
    expect(out.text).toContain('random-person granted without matching a named approver');
  });

  it('stays quiet when the grantor is one of the named approvers', async () => {
    const runtime = new FakeRuntime().on('GET', STATUS_PATH, approval(['security-team']));

    const { out } = await runCli(['approvals', 'status', APPROVAL_ID], runtime);

    expect(out.text).not.toContain('without matching a named approver');
  });

  it('still reports who was asked', async () => {
    const runtime = new FakeRuntime().on('GET', STATUS_PATH, approval(['security-team']));

    const { out } = await runCli(['approvals', 'status', APPROVAL_ID], runtime);

    expect(out.text).toContain('Asked of : security-team');
  });
});
