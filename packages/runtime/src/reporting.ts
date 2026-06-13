import type { ActionEvent, ComplianceReport } from '@memnox/core';
import { DECISION_EFFECT } from '@memnox/core';

const TOP_LIST_SIZE = 10;

export type { ComplianceReport };

/** Pure aggregation over audit events — the evidence base for SOC2/ISO-style AI governance reports. */
export function buildComplianceReport(
  events: ActionEvent[],
  period: { from?: string; to?: string },
): ComplianceReport {
  const riskBreakdown: Record<string, number> = {};
  const blockedActions = new Map<string, number>();
  const policies = new Map<string, number>();
  const agents = new Map<string, { actions: number; blocked: number }>();
  const signals = new Map<string, number>();
  let allowed = 0;
  let blocked = 0;
  let approvalsRequired = 0;

  for (const event of events) {
    riskBreakdown[event.riskLevel] = (riskBreakdown[event.riskLevel] ?? 0) + 1;
    if (event.effect === DECISION_EFFECT.ALLOW) allowed += 1;
    if (event.effect === DECISION_EFFECT.BLOCK) {
      blocked += 1;
      blockedActions.set(event.action, (blockedActions.get(event.action) ?? 0) + 1);
    }
    if (event.effect === DECISION_EFFECT.REQUIRE_APPROVAL) approvalsRequired += 1;

    for (const policy of event.matchedPolicies) {
      policies.set(policy, (policies.get(policy) ?? 0) + 1);
    }
    for (const signal of event.advisories) {
      signals.set(signal, (signals.get(signal) ?? 0) + 1);
    }
    const agent = agents.get(event.agentName) ?? { actions: 0, blocked: 0 };
    agent.actions += 1;
    if (event.effect === DECISION_EFFECT.BLOCK) agent.blocked += 1;
    agents.set(event.agentName, agent);
  }

  return {
    generatedAt: new Date().toISOString(),
    period,
    totals: { actions: events.length, allowed, blocked, approvalsRequired },
    riskBreakdown,
    topBlockedActions: topEntries(blockedActions).map(([action, count]) => ({
      action,
      count,
    })),
    policyActivity: topEntries(policies).map(([policy, count]) => ({ policy, count })),
    agentActivity: [...agents.entries()]
      .sort(([, a], [, b]) => b.actions - a.actions)
      .slice(0, TOP_LIST_SIZE)
      .map(([agent, stats]) => ({ agent, ...stats })),
    advisorySignals: topEntries(signals).map(([signal, count]) => ({ signal, count })),
  };
}

export function renderComplianceReportMarkdown(report: ComplianceReport): string {
  const lines: string[] = [
    '# Memnox AI Governance Report',
    '',
    `Generated: ${report.generatedAt}`,
    `Period: ${report.period.from ?? 'beginning'} → ${report.period.to ?? 'now'}`,
    '',
    '## Totals',
    '',
    `| Actions | Allowed | Blocked | Approvals required |`,
    `|---------|---------|---------|--------------------|`,
    `| ${report.totals.actions} | ${report.totals.allowed} | ${report.totals.blocked} | ${report.totals.approvalsRequired} |`,
    '',
    '## Risk breakdown',
    '',
    ...Object.entries(report.riskBreakdown).map(
      ([level, count]) => `- ${level}: ${count}`,
    ),
  ];

  if (report.topBlockedActions.length > 0) {
    lines.push('', '## Top blocked actions', '');
    lines.push(
      ...report.topBlockedActions.map((entry) => `- ${entry.action}: ${entry.count}`),
    );
  }
  if (report.policyActivity.length > 0) {
    lines.push('', '## Policy activity', '');
    lines.push(
      ...report.policyActivity.map((entry) => `- ${entry.policy}: ${entry.count}`),
    );
  }
  if (report.agentActivity.length > 0) {
    lines.push('', '## Agent activity', '');
    lines.push(
      ...report.agentActivity.map(
        (entry) => `- ${entry.agent}: ${entry.actions} actions, ${entry.blocked} blocked`,
      ),
    );
  }
  if (report.advisorySignals.length > 0) {
    lines.push('', '## Advisory signals', '');
    lines.push(
      ...report.advisorySignals.map((entry) => `- ${entry.signal}: ${entry.count}`),
    );
  }
  return `${lines.join('\n')}\n`;
}

function topEntries(map: Map<string, number>): Array<[string, number]> {
  return [...map.entries()].sort(([, a], [, b]) => b - a).slice(0, TOP_LIST_SIZE);
}

const AUDIT_CSV_COLUMNS = [
  'occurredAt',
  'agentName',
  'action',
  'target',
  'environment',
  'sessionId',
  'effect',
  'riskLevel',
  'matchedPolicies',
  'advisories',
  'reason',
] as const;

/** Audit evidence in the format auditors actually ask for. */
export function renderAuditCsv(events: ActionEvent[]): string {
  const rows = events.map((event) =>
    [
      event.occurredAt,
      event.agentName,
      event.action,
      event.target ?? '',
      event.environment ?? '',
      event.sessionId ?? '',
      event.effect,
      event.riskLevel,
      event.matchedPolicies.join('; '),
      event.advisories.join('; '),
      event.reason,
    ]
      .map(escapeCsv)
      .join(','),
  );
  return [AUDIT_CSV_COLUMNS.join(','), ...rows].join('\n') + '\n';
}

function escapeCsv(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}
