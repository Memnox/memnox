import {
  isBlocking,
  redact,
  toFinding,
  type ShieldFinding,
  type ShieldScanResult,
} from './finding';
import { scanPackageLine } from './package-advisories';
import { classifyPath, isSkippedPath, PATH_KIND, type PathKind } from './path-routing';
import {
  CODE_RULES,
  ENV_FILE_RULE,
  HARDCODED_CREDENTIAL_RULE_ID,
  PLACEHOLDER_VALUE,
  SHIELD_IGNORE_MARKER,
  SHIELD_RULESET_VERSION,
  SHIELD_SEVERITY,
  TEST_CARD_NUMBERS,
} from './shield-rules';

const CARD_CANDIDATE = /\b(?:\d[ -]?){13,16}\b/g;
const CARD_MIN_DIGITS = 13;
const CARD_MAX_DIGITS = 16;
const REPEATED_DIGITS = /^(\d)\1+$/;
const QUOTED_CREDENTIAL_VALUE = /["']([^"']+)["']\s*$/;
const ENV_ASSIGNMENT = '=';

const DIFF_FILE_HEADER = '+++ b/';
const DIFF_DELETED_FILE_HEADER = '+++ /dev/null';
const DIFF_HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/;
const DIFF_ADDED = '+';
const DIFF_REMOVED = '-';

/** Pure line scanner — no network, no filesystem, deterministic. */
export function scanContent(filePath: string, content: string): ShieldFinding[] {
  const kind = classifyPath(filePath);
  if (isSkippedPath(kind)) return [];

  const findings: ShieldFinding[] = [];
  const lines = content.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    findings.push(...scanLine(filePath, lines[index] ?? '', index + 1, kind));
  }
  return findings;
}

/** Scans a unified diff, reporting only lines it ADDS — pre-existing debt never fails an unrelated build. */
export function scanDiff(diff: string): ShieldScanResult {
  const findings: ShieldFinding[] = [];
  const files = new Set<string>();
  let currentFile: string | null = null;
  let currentKind: PathKind = PATH_KIND.CODE;
  let newLine: number | null = null;

  for (const line of diff.split('\n')) {
    if (line.startsWith(DIFF_DELETED_FILE_HEADER)) {
      currentFile = null;
      newLine = null;
      continue;
    }
    if (line.startsWith(DIFF_FILE_HEADER)) {
      currentFile = line.slice(DIFF_FILE_HEADER.length);
      currentKind = classifyPath(currentFile);
      newLine = null;
      continue;
    }
    const hunk = DIFF_HUNK_HEADER.exec(line);
    if (hunk) {
      newLine = Number(hunk[1]);
      continue;
    }
    if (currentFile === null || newLine === null) continue;

    if (line.startsWith(DIFF_ADDED)) {
      files.add(currentFile);
      if (!isSkippedPath(currentKind)) {
        findings.push(...scanLine(currentFile, line.slice(1), newLine, currentKind));
      }
      newLine += 1;
    } else if (!line.startsWith(DIFF_REMOVED)) {
      newLine += 1; // context line advances the new-file counter
    }
  }

  return {
    findings,
    blocked: findings.some(isBlocking),
    scannedFiles: files.size,
    rulesetVersion: SHIELD_RULESET_VERSION,
  };
}

function scanLine(
  file: string,
  text: string,
  line: number,
  kind: PathKind,
): ShieldFinding[] {
  if (text.includes(SHIELD_IGNORE_MARKER)) return [];
  if (kind === PATH_KIND.MANIFEST || kind === PATH_KIND.LOCK_FILE) {
    return scanPackageLine(file, text, line);
  }
  if (kind === PATH_KIND.ENV_FILE) return scanEnvLine(file, text, line);

  const findings: ShieldFinding[] = [];
  for (const rule of CODE_RULES) {
    const match = rule.pattern.exec(text);
    if (!match) continue;
    if (rule.id === HARDCODED_CREDENTIAL_RULE_ID && isPlaceholderCredential(match[0])) {
      continue;
    }
    findings.push(toFinding(rule, file, line, match[0]));
  }

  const card = findCardNumber(text);
  if (card !== null) {
    findings.push({
      rule: 'credit-card-number',
      severity: SHIELD_SEVERITY.HIGH,
      file,
      line,
      excerpt: redact(card),
      message: 'Possible real payment card number',
      fix: 'Remove the card number; cardholder data must never be written by an agent.',
    });
  }
  return findings;
}

function scanEnvLine(file: string, text: string, line: number): ShieldFinding[] {
  const match = ENV_FILE_RULE.pattern.exec(text);
  if (!match) return [];
  const value = text.slice(text.indexOf(ENV_ASSIGNMENT) + 1);
  if (PLACEHOLDER_VALUE.test(value)) return [];
  return [toFinding(ENV_FILE_RULE, file, line, match[0])];
}

/** Scoped to the assigned value: a line mentioning "example" elsewhere must not mute a real secret. */
function isPlaceholderCredential(matched: string): boolean {
  const quoted = QUOTED_CREDENTIAL_VALUE.exec(matched);
  const value = quoted === null ? '' : (quoted[1] ?? '');
  return PLACEHOLDER_VALUE.test(value);
}

/** Luhn-validated with a public-test-number allowlist — card detection without the noise. */
function findCardNumber(text: string): string | null {
  for (const match of text.matchAll(CARD_CANDIDATE)) {
    const digits = match[0].replace(/[ -]/g, '');
    if (digits.length < CARD_MIN_DIGITS || digits.length > CARD_MAX_DIGITS) continue;
    if (TEST_CARD_NUMBERS.includes(digits)) continue;
    if (REPEATED_DIGITS.test(digits)) continue;
    if (passesLuhn(digits)) return digits;
  }
  return null;
}

function passesLuhn(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let digit = Number(digits[i]);
    if (double) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    double = !double;
  }
  return sum % 10 === 0;
}
