import { SHIELD_SEVERITY, type ShieldRule, type ShieldSeverity } from './shield-rules';

const REDACT_VISIBLE_CHARS = 8;
const EXCERPT_MAX_CHARS = 120;
const ELLIPSIS = '…';

export interface ShieldFinding {
  rule: string;
  severity: ShieldSeverity;
  file: string;
  line: number;
  excerpt: string;
  message: string;
  fix: string;
}

export interface ShieldScanResult {
  findings: ShieldFinding[];
  blocked: boolean;
  scannedFiles: number;
  rulesetVersion: string;
}

export function isBlocking(finding: ShieldFinding): boolean {
  return (
    finding.severity === SHIELD_SEVERITY.CRITICAL ||
    finding.severity === SHIELD_SEVERITY.HIGH
  );
}

/** Findings never echo the full secret. */
export function redact(value: string): string {
  return `${value.slice(0, REDACT_VISIBLE_CHARS)}${ELLIPSIS} (redacted, ${value.length} chars)`;
}

export function truncate(value: string): string {
  return value.length > EXCERPT_MAX_CHARS
    ? `${value.slice(0, EXCERPT_MAX_CHARS - 1)}${ELLIPSIS}`
    : value;
}

export function toFinding(
  rule: ShieldRule,
  file: string,
  line: number,
  matched: string,
): ShieldFinding {
  return {
    rule: rule.id,
    severity: rule.severity,
    file,
    line,
    excerpt: rule.redact === true ? redact(matched) : truncate(matched),
    message: rule.message,
    fix: rule.fix,
  };
}
