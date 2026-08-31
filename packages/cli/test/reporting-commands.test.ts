import { describe, expect, it } from 'vitest';
import type { ComplianceReport } from '@memnox/core';
import { FakeRuntime, runCli } from './cli-harness';

const REPORT_PATH = '/v1/reports/compliance';

const report = (over: Partial<ComplianceReport> = {}): ComplianceReport => ({
  generatedAt: '2026-07-27T12:00:00.000Z',
  period: { from: '2026-07-01T00:00:00.000Z', to: '2026-07-27T00:00:00.000Z' },
  totals: { actions: 120, allowed: 100, withheld: 12, approvalsRequired: 8 },
  riskBreakdown: { low: 80, medium: 20, high: 15, critical: 5 },
  topBlockedActions: [{ action: 'database.delete', count: 7 }],
  policyActivity: [{ policy: 'production-database-protection', count: 7 }],
  agentActivity: [{ agent: 'claude-code', actions: 120, withheld: 12 }],
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
    defied: 0,
    unreportedActions: [{ action: 'code.modify', count: 40 }],
  },
  ...over,
});

describe('memnox evidence export', () => {
  it('emits the raw report with --format json', async () => {
    const runtime = new FakeRuntime().on('GET', REPORT_PATH, report());

    const { out } = await runCli(['evidence', '--format', 'json'], runtime);

    const parsed = JSON.parse(out.text) as { totals: { actions: number } };
    expect(parsed.totals.actions).toBe(120);
  });

  it('renders markdown by default, not JSON', async () => {
    const runtime = new FakeRuntime().on('GET', REPORT_PATH, report());

    const { out } = await runCli(['evidence'], runtime);

    expect(out.text).not.toContain('"totals"');
    expect(out.text).toContain('120');
  });

  it('reads the compliance endpoint for the requested period', async () => {
    const runtime = new FakeRuntime().on('GET', REPORT_PATH, report());

    await runCli(
      ['evidence', '--from', '2026-07-01', '--to', '2026-07-27', '--format', 'json'],
      runtime,
    );

    expect(runtime.requests[0]?.path).toBe(REPORT_PATH);
  });
});
