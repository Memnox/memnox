import { describe, expect, it } from 'vitest';
import type { ApprovalFlowSummary, ComplianceReport } from '@memnox/core';
import { FakeRuntime, runCli } from './cli-harness';

const REPORT_PATH = '/v1/reports/compliance';
const APPROVAL_HEALTH_PATH = '/v1/approvals/health';

const report = (over: Partial<ComplianceReport> = {}): ComplianceReport => ({
  generatedAt: '2026-07-27T12:00:00.000Z',
  period: { from: '2026-07-01T00:00:00.000Z', to: '2026-07-27T00:00:00.000Z' },
  totals: { actions: 120, allowed: 100, blocked: 12, approvalsRequired: 8 },
  riskBreakdown: { low: 80, medium: 20, high: 15, critical: 5 },
  topBlockedActions: [{ action: 'database.delete', count: 7 }],
  policyActivity: [{ policy: 'production-database-protection', count: 7 }],
  agentActivity: [{ agent: 'claude-code', actions: 120, blocked: 12 }],
  advisorySignals: [{ signal: 'taint', count: 3 }],
  verification: {
    allowed: 100,
    reported: 60,
    unreported: 40,
    inFlight: 0,
    succeeded: 55,
    failed: 5,
    rolledBack: 3,
    rollbackFailed: 1,
    unreportedActions: [{ action: 'code.modify', count: 40 }],
  },
  ...over,
});

const approvalHealth = (
  over: Partial<ApprovalFlowSummary> = {},
): ApprovalFlowSummary => ({
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

/** insights reads two endpoints; both must be stubbed or the SDK throws on 404. */
const insightsRuntime = (
  reportBody = report(),
  approvalsBody = approvalHealth(),
): FakeRuntime =>
  new FakeRuntime()
    .on('GET', REPORT_PATH, reportBody)
    .on('GET', APPROVAL_HEALTH_PATH, approvalsBody);

describe('memnox insights', () => {
  it('summarises what the runtime handled and stopped', async () => {
    const { out } = await runCli(['insights'], insightsRuntime());

    expect(out.text).toContain('Protected actions : 120');
    expect(out.text).toContain('Allowed           : 100');
    expect(out.text).toContain('Blocked           : 12');
    expect(out.text).toContain('Sent to approval  : 8');
  });

  it('ranks the most blocked actions and the advisory signals', async () => {
    const { out } = await runCli(['insights'], insightsRuntime());

    expect(out.text).toContain('Most blocked actions:');
    expect(out.text).toContain('- database.delete (7)');
    expect(out.text).toContain('Behavioral signals:');
    expect(out.text).toContain('- taint (3)');
  });

  it('omits both lists when there is nothing to rank', async () => {
    const runtime = insightsRuntime(
      report({ topBlockedActions: [], advisorySignals: [] }),
    );

    const { out } = await runCli(['insights'], runtime);

    expect(out.text).not.toContain('Most blocked actions:');
    expect(out.text).not.toContain('Behavioral signals:');
  });

  it('reports execution coverage without calling silence a failure', async () => {
    const { out } = await runCli(['insights'], insightsRuntime());

    expect(out.text).toContain('Outcomes reported : 60/100 allowed decisions');
    expect(out.text).toContain('5 failed, 1 rollback failed');
    expect(out.text).toContain('40 reported no outcome');
    expect(out.text).toContain('did not use guarded execution');
  });

  it('reports where approvals stall, in units a human reads', async () => {
    const { out } = await runCli(['insights'], insightsRuntime());

    expect(out.text).toContain('Approval flow:');
    expect(out.text).toContain('Waiting now     : 2');
    expect(out.text).toContain('Lapsed unread   : 1');
    expect(out.text).toContain('Break-glass     : 1');
    expect(out.text).toContain('Time to resolve : 45m median, 3h p90');
    expect(out.text).toContain('Oldest waiting  : 2d');
  });

  it('shows an em dash rather than 0m when nothing has resolved yet', async () => {
    const runtime = insightsRuntime(
      report(),
      approvalHealth({ medianResolveMinutes: null, p90ResolveMinutes: null }),
    );

    const { out } = await runCli(['insights'], runtime);

    expect(out.text).toContain('Time to resolve : — median, — p90');
  });

  it('omits the approval block entirely when nothing was ever raised', async () => {
    const runtime = insightsRuntime(report(), approvalHealth({ total: 0 }));

    const { out } = await runCli(['insights'], runtime);

    expect(out.text).not.toContain('Approval flow:');
  });
});

describe('memnox report', () => {
  it('emits the raw report with --format json', async () => {
    const runtime = new FakeRuntime().on('GET', REPORT_PATH, report());

    const { out } = await runCli(['report', '--format', 'json'], runtime);

    const parsed = JSON.parse(out.text) as { totals: { actions: number } };
    expect(parsed.totals.actions).toBe(120);
  });

  it('renders markdown by default, not JSON', async () => {
    const runtime = new FakeRuntime().on('GET', REPORT_PATH, report());

    const { out } = await runCli(['report'], runtime);

    expect(out.text).not.toContain('"totals"');
    expect(out.text).toContain('120');
  });

  it('reads the compliance endpoint for the requested period', async () => {
    const runtime = new FakeRuntime().on('GET', REPORT_PATH, report());

    await runCli(
      ['report', '--from', '2026-07-01', '--to', '2026-07-27', '--format', 'json'],
      runtime,
    );

    expect(runtime.requests[0]?.path).toBe(REPORT_PATH);
  });
});
