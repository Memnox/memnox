import { describe, expect, it } from 'vitest';
import type { ActionEvent } from '@memnox/core';
import { DECISION_EFFECT, RISK_LEVEL } from '@memnox/core';
import { buildComplianceReport, renderComplianceReportMarkdown } from '../src/reporting';

function event(overrides: Partial<ActionEvent>): ActionEvent {
  return {
    id: 'evt',
    occurredAt: '2026-07-01T00:00:00.000Z',
    agentId: 'agent-1',
    agentName: 'claude-code',
    action: 'repository.read',
    effect: DECISION_EFFECT.ALLOW,
    riskLevel: RISK_LEVEL.LOW,
    matchedPolicies: [],
    advisories: [],
    reason: 'ok',
    ...overrides,
  };
}

describe('compliance reporting', () => {
  it('aggregates totals, policies, agents, and signals', () => {
    const events = [
      event({}),
      event({
        action: 'database.delete',
        effect: DECISION_EFFECT.WITHHOLD,
        riskLevel: RISK_LEVEL.CRITICAL,
        matchedPolicies: ['production-database-protection'],
        advisories: ['behavior-guard:novel-destructive-action'],
      }),
      event({ effect: DECISION_EFFECT.ESCALATE, action: 'deploy.service' }),
    ];
    const report = buildComplianceReport(events, { from: '2026-06-01' });

    expect(report.totals).toEqual({
      actions: 3,
      allowed: 1,
      withheld: 1,
      approvalsRequired: 1,
    });
    expect(report.topBlockedActions).toEqual([{ action: 'database.delete', count: 1 }]);
    expect(report.policyActivity).toEqual([
      { policy: 'production-database-protection', count: 1 },
    ]);
    expect(report.agentActivity[0]).toEqual({
      agent: 'claude-code',
      actions: 3,
      withheld: 1,
    });
    expect(report.advisorySignals).toEqual([
      { signal: 'behavior-guard:novel-destructive-action', count: 1 },
    ]);
  });

  it('renders readable markdown', () => {
    const markdown = renderComplianceReportMarkdown(
      buildComplianceReport([event({})], {}),
    );
    expect(markdown).toContain('# Memnox AI Governance Report');
    expect(markdown).toContain('| 1 | 1 | 0 | 0 |');
  });
});
