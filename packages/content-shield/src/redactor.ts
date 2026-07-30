import { findCardNumber } from './scanner';
import {
  CODE_RULES,
  ENV_FILE_RULE,
  PLACEHOLDER_VALUE,
  SHIELD_RULESET_VERSION,
  type ShieldRule,
} from './shield-rules';

/**
 * Chosen so a masked line reads as a placeholder to the scanner itself — see
 * PLACEHOLDER_VALUE. Redacting and then re-scanning must come back clean, or a
 * redact rule would block the very call it just made safe.
 */
export const REDACTION_MASK = 'redacted-by-memnox';

const PRIVATE_KEY_BEGIN = /-----BEGIN (?:[A-Z ]+)?PRIVATE KEY(?: BLOCK)?-----/;
const PRIVATE_KEY_END = /-----END (?:[A-Z ]+)?PRIVATE KEY(?: BLOCK)?-----/;
const PRIVATE_KEY_RULE_ID = 'private-key-block';

export interface Redaction {
  rule: string;
  count: number;
}

export interface RedactionResult {
  text: string;
  /** Empty when nothing matched — the caller can then forward the original. */
  redactions: Redaction[];
  rulesetVersion: string;
}

/** Rules whose match IS the secret; masking the match removes the secret itself. */
const MASKING_RULES: readonly ShieldRule[] = [
  ...CODE_RULES.filter((rule) => rule.redact === true),
  ENV_FILE_RULE,
];

/**
 * Masks the secrets in a string in place, leaving the surrounding text intact so
 * the call still means what it meant. Deterministic and offline: this runs at
 * the enforcement point, on a payload that never leaves the machine.
 */
export function redactSecrets(text: string): RedactionResult {
  const counts = new Map<string, number>();
  const lines = text.split('\n');
  const masked: string[] = [];
  let insidePrivateKey = false;

  for (const line of lines) {
    if (insidePrivateKey) {
      count(counts, PRIVATE_KEY_RULE_ID);
      if (PRIVATE_KEY_END.test(line)) insidePrivateKey = false;
      continue; // The key body is dropped outright; masking it line by line keeps nothing useful.
    }
    if (PRIVATE_KEY_BEGIN.test(line)) {
      count(counts, PRIVATE_KEY_RULE_ID);
      insidePrivateKey = !PRIVATE_KEY_END.test(line);
      masked.push(REDACTION_MASK);
      continue;
    }
    masked.push(maskLine(line, counts));
  }

  return {
    text: masked.join('\n'),
    redactions: [...counts.entries()].map(([rule, occurrences]) => ({
      rule,
      count: occurrences,
    })),
    rulesetVersion: SHIELD_RULESET_VERSION,
  };
}

function maskLine(line: string, counts: Map<string, number>): string {
  let masked = line;
  for (const rule of MASKING_RULES) {
    const pattern = globalize(rule.pattern);
    // A placeholder is not a secret, so masking it would only obscure the file.
    if (rule === ENV_FILE_RULE && isPlaceholderAssignment(masked)) continue;
    masked = masked.replace(pattern, (match) => {
      count(counts, rule.id);
      return maskWithin(match);
    });
  }

  const card = findCardNumber(masked);
  if (card !== null) {
    count(counts, 'credit-card-number');
    masked = masked.replace(cardPattern(card), REDACTION_MASK);
  }
  return masked;
}

/**
 * Some rules match an assignment (`api_key = "…"`), not a bare secret. Keeping
 * the part before the value leaves the line readable and still says what was
 * masked; the value itself is replaced whole.
 */
function maskWithin(match: string): string {
  const separator = match.search(/[:=]/);
  if (separator === -1) return REDACTION_MASK;
  return `${match.slice(0, separator + 1)} "${REDACTION_MASK}"`;
}

function isPlaceholderAssignment(line: string): boolean {
  const separator = line.indexOf('=');
  if (separator === -1) return false;
  return PLACEHOLDER_VALUE.test(line.slice(separator + 1));
}

/** Card digits may be spaced or hyphenated in the text they were found in. */
function cardPattern(digits: string): RegExp {
  return new RegExp([...digits].join('[ -]?'), 'g');
}

function globalize(pattern: RegExp): RegExp {
  return pattern.flags.includes('g')
    ? pattern
    : new RegExp(pattern.source, `${pattern.flags}g`);
}

function count(counts: Map<string, number>, rule: string): void {
  counts.set(rule, (counts.get(rule) ?? 0) + 1);
}
