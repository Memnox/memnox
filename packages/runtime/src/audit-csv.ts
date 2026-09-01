import type { ActionEvent } from '@memnox/core';

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
