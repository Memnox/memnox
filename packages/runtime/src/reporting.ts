import type { ActionEvent, ComplianceReport, VerificationCoverage } from '@memnox/core';
import {
  DECISION_EFFECT,
  EXECUTION_OUTCOME_ACTION,
  EXECUTION_OUTCOME_GRACE_MS,
  EXECUTION_STATUS,
} from '@memnox/core';
import { BOOKKEEPING_ACTIONS } from '@memnox/risk';

const TOP_LIST_SIZE = 10;

export type { ComplianceReport };

/** Pure aggregation over audit events — the evidence base for SOC2/ISO-style AI governance reports. */
export function buildComplianceReport(
  events: ActionEvent[],
  period: { from?: string; to?: string },
  now: Date = new Date(),
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
    generatedAt: now.toISOString(),
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
    verification: buildVerificationCoverage(events, now),
  };
}

/**
 * Joins reported outcomes onto the decisions that authorized them. A decision
 * with no outcome is unreported, never "failed" — the runtime only ever holds
 * the caller's testimony, and silence is not evidence of harm.
 *
 * `now` is passed in rather than read so the same events always produce the
 * same coverage, the discipline every other time-aware fold here follows.
 */
function buildVerificationCoverage(
  events: ActionEvent[],
  now: Date,
): VerificationCoverage {
  const overdueBefore = now.getTime() - EXECUTION_OUTCOME_GRACE_MS;
  const outcomes = new Map<string, ActionEvent>();
  for (const event of events) {
    if (event.action !== EXECUTION_OUTCOME_ACTION) continue;
    if (event.decisionEventId === undefined) continue;
    outcomes.set(event.decisionEventId, event);
  }

  // Counted over every outcome, not only those joined to an allowed decision —
  // a defiance is precisely an outcome whose decision was not an allow.
  let defied = 0;
  for (const outcome of outcomes.values()) {
    if (outcome.defiedVerdict === true) defied += 1;
  }

  const unreportedActions = new Map<string, number>();
  let allowed = 0;
  let reported = 0;
  let unreported = 0;
  let inFlight = 0;
  let succeeded = 0;
  let failed = 0;
  let rolledBack = 0;
  let rollbackFailed = 0;

  for (const event of events) {
    if (event.effect !== DECISION_EFFECT.ALLOW) continue;
    if (BOOKKEEPING_ACTIONS.includes(event.action)) continue;
    allowed += 1;

    const outcome = outcomes.get(event.id);
    if (outcome === undefined) {
      // Too recent to be overdue: the action may still be running.
      if (Date.parse(event.occurredAt) > overdueBefore) {
        inFlight += 1;
        continue;
      }
      unreported += 1;
      unreportedActions.set(event.action, (unreportedActions.get(event.action) ?? 0) + 1);
      continue;
    }
    reported += 1;
    if (outcome.executionStatus === EXECUTION_STATUS.SUCCEEDED) succeeded += 1;
    else failed += 1;
    if (outcome.rolledBack === true) rolledBack += 1;
    if (outcome.rollbackFailed === true) rollbackFailed += 1;
  }

  return {
    allowed,
    reported,
    unreported,
    inFlight,
    succeeded,
    failed,
    rolledBack,
    rollbackFailed,
    defied,
    unreportedActions: topEntries(unreportedActions).map(([action, count]) => ({
      action,
      count,
    })),
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

  const { verification } = report;
  if (verification.allowed > 0) {
    lines.push(
      '',
      '## Execution verification',
      '',
      `${verification.reported} of ${verification.allowed} allowed decisions reported an outcome.`,
      '',
      `- succeeded: ${verification.succeeded}`,
      `- failed or unverified: ${verification.failed}`,
      `- rolled back: ${verification.rolledBack}`,
      `- rollback failed (state unknown): ${verification.rollbackFailed}`,
      `- no outcome reported: ${verification.unreported}`,
      `- too recent to be overdue: ${verification.inFlight}`,
      '',
      'An unreported decision means no outcome was reported for it, not that the action failed.',
    );
    if (verification.defied > 0) {
      lines.push(
        '',
        '### Reported acting without permission',
        '',
        `${verification.defied} outcome(s) claim success on an action this runtime did not allow.`,
        'Each names the decision it contradicts; find them with "memnox audit".',
      );
    }
    if (verification.unreportedActions.length > 0) {
      lines.push('', '### Awaiting an outcome', '');
      lines.push(
        ...verification.unreportedActions.map(
          (entry) => `- ${entry.action}: ${entry.count}`,
        ),
      );
    }
  }

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
