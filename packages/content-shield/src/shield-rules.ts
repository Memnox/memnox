/** Bumped whenever the rule corpus changes — recorded in scan results so an audit can be reproduced. */
export const SHIELD_RULESET_VERSION = '1.1.0';

export const SHIELD_SEVERITY = {
  CRITICAL: 'critical',
  HIGH: 'high',
  MEDIUM: 'medium',
} as const;

export type ShieldSeverity = (typeof SHIELD_SEVERITY)[keyof typeof SHIELD_SEVERITY];

export interface ShieldRule {
  id: string;
  severity: ShieldSeverity;
  pattern: RegExp;
  message: string;
  fix: string;
  /** Excerpt is masked — set on any rule whose match can contain the secret itself. */
  redact?: boolean;
}

/** A comment containing this marker suppresses findings on that line. */
export const SHIELD_IGNORE_MARKER = 'memnox-shield-ignore';

/** Anchored: only a value that STARTS with one of these is a placeholder, so a real secret merely mentioning one still fires. */
export const PLACEHOLDER_VALUE =
  /^\s*(?:\$\{|\$[A-Z_]|process\.env|os\.environ|<[^>]*>|your[-_]|xxx+|\*{3,}|change[-_]?me|example|placeholder|dummy|sample|redacted|fixme|todo)/i;

/** Card numbers that are public test values, not findings. */
export const TEST_CARD_NUMBERS: readonly string[] = [
  '4242424242424242',
  '4111111111111111',
  '5555555555554444',
  '378282246310005',
];

/** Rule id the placeholder check applies to — scoped to its captured value, never the whole line. */
export const HARDCODED_CREDENTIAL_RULE_ID = 'hardcoded-credential';

export const CODE_RULES: readonly ShieldRule[] = [
  {
    id: 'aws-access-key',
    severity: SHIELD_SEVERITY.CRITICAL,
    redact: true,
    pattern: /\bAKIA[0-9A-Z]{16}\b/,
    message: 'AWS access key ID',
    fix: 'Move the key to environment configuration and rotate it — it is now exposed.',
  },
  {
    id: 'private-key-block',
    severity: SHIELD_SEVERITY.CRITICAL,
    pattern: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY(?: BLOCK)?-----/,
    message: 'Private key material',
    fix: 'Never commit private keys. Load them from a secret store and rotate this one.',
  },
  {
    id: 'github-token',
    severity: SHIELD_SEVERITY.CRITICAL,
    redact: true,
    pattern: /\b(?:gh[poasru]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})\b/,
    message: 'GitHub token',
    fix: 'Revoke the token in GitHub settings and use an environment variable.',
  },
  {
    id: 'slack-token',
    severity: SHIELD_SEVERITY.CRITICAL,
    redact: true,
    pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/,
    message: 'Slack token',
    fix: 'Revoke the token in the Slack app config and use an environment variable.',
  },
  {
    id: 'stripe-live-key',
    severity: SHIELD_SEVERITY.CRITICAL,
    redact: true,
    pattern: /\b[sr]k_live_[A-Za-z0-9]{16,}\b/,
    message: 'Stripe live key',
    fix: 'Roll the key in the Stripe dashboard immediately.',
  },
  {
    id: 'anthropic-key',
    severity: SHIELD_SEVERITY.CRITICAL,
    redact: true,
    pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/,
    message: 'Anthropic API key',
    fix: 'Rotate the key in the Anthropic console and use an environment variable.',
  },
  {
    id: 'openai-key',
    severity: SHIELD_SEVERITY.CRITICAL,
    redact: true,
    pattern: /\bsk-[A-Za-z0-9]*T3BlbkFJ[A-Za-z0-9]*\b/,
    message: 'OpenAI API key',
    fix: 'Rotate the key in the OpenAI dashboard and use an environment variable.',
  },
  {
    id: 'google-api-key',
    severity: SHIELD_SEVERITY.CRITICAL,
    redact: true,
    pattern: /\bAIza[0-9A-Za-z_-]{35}\b/,
    message: 'Google API key',
    fix: 'Rotate the key in the Google Cloud console and restrict it.',
  },
  {
    id: 'connection-string-password',
    severity: SHIELD_SEVERITY.CRITICAL,
    redact: true,
    pattern:
      /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqps?):\/\/[^\s:/]+:[^@\s]+@/,
    message: 'Database connection string with embedded password',
    fix: 'Reference the password from environment configuration and rotate it.',
  },
  {
    id: HARDCODED_CREDENTIAL_RULE_ID,
    severity: SHIELD_SEVERITY.HIGH,
    redact: true,
    pattern:
      /\b(?:password|passwd|pwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|private[_-]?key)\b\s*[:=]\s*['"][^'"]{8,}['"]/i,
    message: 'Hardcoded credential assignment',
    fix: 'Read the value from environment configuration instead of the source.',
  },
  {
    id: 'sensitive-logging/credentials',
    severity: SHIELD_SEVERITY.HIGH,
    pattern:
      /(?:console\.(?:log|info|warn|error|debug)|\blog(?:ger)?\.(?:log|info|warn|error|debug|verbose|trace)|\bprint(?:ln)?)\s*\([^)]*\b(?:password|passwd|pwd|passphrase|client[_-]?secret|refresh[_-]?token|access[_-]?token|api[_-]?key|credit[_-]?card|card[_-]?number|cvv|ssn|social[_-]?security)\b/i,
    message: 'Sensitive value (password/token/card/SSN) written to logs in plain text',
    fix: 'Never log credentials or PII — log an event name or a redacted identifier instead.',
  },
  {
    id: 'sensitive-logging/request-body',
    severity: SHIELD_SEVERITY.MEDIUM,
    pattern:
      /(?:console\.(?:log|info|warn|error|debug)|\blog(?:ger)?\.(?:log|info|warn|error|debug|verbose|trace))\s*\([^)]*\breq(?:uest)?\.body\b/,
    message: 'Full request body written to logs — may contain credentials or PII',
    fix: 'Log only the specific safe fields you need, never the raw body.',
  },
  {
    id: 'pii/ssn-literal',
    severity: SHIELD_SEVERITY.HIGH,
    redact: true,
    pattern: /\b\d{3}-\d{2}-\d{4}\b/,
    message: 'Value shaped like a US Social Security Number',
    fix: 'Remove or mask the identifier; if test data is needed use an obviously fake marker.',
  },
  {
    id: 'pii/logged-pii-fields',
    severity: SHIELD_SEVERITY.MEDIUM,
    pattern:
      /(?:console\.(?:log|info|warn|error|debug)|\blog(?:ger)?\.(?:log|info|warn|error|debug|verbose|trace))\s*\([^)]*\b(?:email|e[-_]mail|phone[-_]?number|date[-_]?of[-_]?birth|dob|home[-_]?address)\b/i,
    message: 'PII field (email/phone/DOB/address) written to logs',
    fix: 'Log a user ID instead of raw PII, or redact before logging.',
  },
] as const;

/** Real credentials committed inside a .env file — bare KEY=value, no quoting required. */
export const ENV_FILE_RULE: ShieldRule = {
  id: 'secret/env-file-credential',
  severity: SHIELD_SEVERITY.HIGH,
  redact: true,
  pattern:
    /^\s*[A-Z][A-Z0-9_]*(?:PASSWORD|SECRET|TOKEN|API_KEY|PRIVATE_KEY|CREDENTIALS?)[A-Z0-9_]*\s*=\s*\S{8,}/,
  message: 'Real credential committed inside a .env file',
  fix: 'Keep .env gitignored; commit only a .env.example with placeholder values.',
};
