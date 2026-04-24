import { describe, expect, it } from 'vitest';
import { isBlocking } from '../src/finding';
import { scanContent } from '../src/scanner';
import { SHIELD_SEVERITY } from '../src/shield-rules';

// Secrets are assembled at runtime so no literal credential ever exists in this file.
const FAKE_AWS_KEY = ['AKIA', 'IOSFODNN7', 'REALKEY'].join('');
const FAKE_CONNECTION = ['postgres', '://admin:hunter2secret@db.internal:5432/app'].join(
  '',
);
const FAKE_CREDENTIAL_LINE = ['password', ': "s3cr3t-value-9"'].join('');
const LUHN_VALID_CARD = ['45395787', '63621486'].join('');
const LUHN_INVALID_CARD = ['45395787', '63621487'].join('');
const FAKE_SSN = ['078', '05', '1120'].join('-');
const LOG_CREDENTIAL = ['console', '.log("login failed for", ', 'password)'].join('');
const LOG_REQUEST_BODY = ['console', '.log("incoming", ', 'req.body)'].join('');
const LOG_PII = ['logger', '.info("welcome", ', 'email)'].join('');
const LOG_SAFE = ['console', '.log("login failed for", ', 'userId)'].join('');
const ENV_CREDENTIAL = ['DATABASE_PASSWORD', '=hunter2hunter2'].join('');
const ENV_PLACEHOLDER = ['DATABASE_PASSWORD', '=changeme'].join('');

describe('scanContent', () => {
  it('finds a live AWS key and redacts the excerpt', () => {
    const findings = scanContent('config.ts', `const key = "${FAKE_AWS_KEY}";`);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.rule).toBe('aws-access-key');
    expect(findings[0]?.severity).toBe(SHIELD_SEVERITY.CRITICAL);
    expect(findings[0]?.file).toBe('config.ts');
    expect(findings[0]?.excerpt).not.toContain('REALKEY');
    expect(isBlocking(findings[0]!)).toBe(true);
  });

  it('finds connection strings with embedded passwords and hardcoded credentials', () => {
    const content = [`DATABASE_URL=${FAKE_CONNECTION}`, FAKE_CREDENTIAL_LINE].join('\n');
    const rules = scanContent('settings.ts', content).map((finding) => finding.rule);
    expect(rules).toContain('connection-string-password');
    expect(rules).toContain('hardcoded-credential');
  });

  it('suppresses placeholders and env references', () => {
    const content = [
      'const key = process.env.AWS_ACCESS_KEY_ID;',
      'password: "${DB_PASSWORD}"',
      'apiKey: "your-api-key-here"',
      'token = "<paste token here>"',
    ].join('\n');
    expect(scanContent('config.ts', content)).toHaveLength(0);
  });

  it('still reports a real secret on a line that merely mentions a placeholder word', () => {
    const line = `const apiKey = "${FAKE_AWS_KEY}"; // replace the example value above`;
    const rules = scanContent('config.ts', line).map((finding) => finding.rule);
    expect(rules).toContain('aws-access-key');
    expect(rules).toContain('hardcoded-credential');
  });

  it('honours the per-line ignore marker and skips sample files', () => {
    const marker = ['memnox-shield', 'ignore'].join('-');
    expect(
      scanContent('config.ts', `const key = "${FAKE_AWS_KEY}"; // ${marker}`),
    ).toHaveLength(0);
    expect(scanContent('.env.example', FAKE_AWS_KEY)).toHaveLength(0);
  });

  it('validates cards with Luhn and allows public test numbers', () => {
    expect(scanContent('order.ts', 'card: 4242424242424242')).toHaveLength(0);
    const real = scanContent('order.ts', `card: ${LUHN_VALID_CARD}`);
    expect(real[0]?.rule).toBe('credit-card-number');
    expect(scanContent('order.ts', `card: ${LUHN_INVALID_CARD}`)).toHaveLength(0);
  });

  it('flags credentials and request bodies written to logs', () => {
    const credentials = scanContent('auth.ts', LOG_CREDENTIAL);
    expect(credentials[0]?.rule).toBe('sensitive-logging/credentials');
    expect(credentials[0]?.severity).toBe(SHIELD_SEVERITY.HIGH);
    expect(credentials[0]?.excerpt).toContain('login failed for'); // code excerpts are not redacted

    const body = scanContent('routes.ts', LOG_REQUEST_BODY);
    expect(body.map((finding) => finding.rule)).toContain(
      'sensitive-logging/request-body',
    );
  });

  it('flags logged PII fields and SSN literals but not safe log calls', () => {
    const pii = scanContent('user.ts', LOG_PII);
    expect(pii[0]?.rule).toBe('pii/logged-pii-fields');
    expect(pii[0]?.severity).toBe(SHIELD_SEVERITY.MEDIUM);

    const ssn = scanContent('user.ts', `const taxId = "${FAKE_SSN}";`);
    expect(ssn[0]?.rule).toBe('pii/ssn-literal');
    expect(ssn[0]?.severity).toBe(SHIELD_SEVERITY.HIGH);
    expect(ssn[0]?.excerpt).not.toContain(FAKE_SSN);

    expect(scanContent('auth.ts', LOG_SAFE)).toHaveLength(0);
  });

  it('applies the env-file rule only to .env paths', () => {
    const env = scanContent('.env', ENV_CREDENTIAL);
    expect(env).toHaveLength(1);
    expect(env[0]?.rule).toBe('secret/env-file-credential');
    expect(env[0]?.severity).toBe(SHIELD_SEVERITY.HIGH);

    expect(scanContent('.env', ENV_PLACEHOLDER)).toHaveLength(0);
    expect(scanContent('.env.production', ENV_CREDENTIAL)).toHaveLength(1);
    expect(scanContent('deploy.ts', ENV_CREDENTIAL)).toHaveLength(0);
  });

  it('routes by path — manifests, minified bundles and docs skip the code rules', () => {
    expect(scanContent('package.json', `"awsKey": "${FAKE_AWS_KEY}"`)).toHaveLength(0);
    expect(scanContent('vendor/app.min.js', `k="${FAKE_AWS_KEY}"`)).toHaveLength(0);
    expect(scanContent('docs/setup.md', `key = "${FAKE_AWS_KEY}"`)).toHaveLength(0);
    expect(scanContent('test/fixtures/keys.ts', FAKE_AWS_KEY)).toHaveLength(0);
    expect(scanContent('src/keys.ts', FAKE_AWS_KEY)).toHaveLength(1);
  });
});
