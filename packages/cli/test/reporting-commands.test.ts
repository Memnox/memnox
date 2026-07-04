import { describe, expect, it } from 'vitest';
import type { ComplianceReport } from '@memnox/core';
import { FakeRuntime, runCli } from './cli-harness';

const REPORT_PATH = '/v1/reports/compliance';

const report = (over: Partial<ComplianceReport> = {}): ComplianceReport => ({
  generatedAt: '2026-07-27T12:00:00.000Z',
  period: { from: '2026-07-01T00:00:00.000Z', to: '2026-07-27T00:00:00.000Z' },
  totals: { actions: 120, allowed: 100, blocked: 12, approvalsRequired: 8 },
  riskBreakdown: { low: 80, medium: 20, high: 15, critical: 5 },
  topBlockedActions: [{ action: 'database.delete', count: 7 }],
  policyActivity: [{ policy: 'production-database-protection', count: 7 }],
  agentActivity: [{ agent: 'claude-code', actions: 120, blocked: 12 }],
  advisorySignals: [{ signal: 'taint', count: 3 }],
  ...over,
});

describe('memnox insights', () => {
  it('summarises what the runtime handled and stopped', async () => {
    const runtime = new FakeRuntime().on('GET', REPORT_PATH, report());

    const { out } = await runCli(['insights'], runtime);

    expect(out.text).toContain('Protected actions : 120');
    expect(out.text).toContain('Allowed           : 100');
    expect(out.text).toContain('Blocked           : 12');
    expect(out.text).toContain('Sent to approval  : 8');
  });

  it('ranks the most blocked actions and the advisory signals', async () => {
    const runtime = new FakeRuntime().on('GET', REPORT_PATH, report());

    const { out } = await runCli(['insights'], runtime);

    expect(out.text).toContain('Most blocked actions:');
    expect(out.text).toContain('- database.delete (7)');
    expect(out.text).toContain('Behavioral signals:');
    expect(out.text).toContain('- taint (3)');
  });

  it('omits both lists when there is nothing to rank', async () => {
    const runtime = new FakeRuntime().on(
      'GET',
      REPORT_PATH,
      report({ topBlockedActions: [], advisorySignals: [] }),
    );

    const { out } = await runCli(['insights'], runtime);

    expect(out.text).not.toContain('Most blocked actions:');
    expect(out.text).not.toContain('Behavioral signals:');
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
