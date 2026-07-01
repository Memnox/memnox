import { describe, expect, it } from 'vitest';
import { shieldDenialMessage } from '../src/write-shield';

// Assembled at runtime so no credential-shaped literals exist in this file.
const AWS_KEY = ['AKIA', 'IOSFODNN7', 'HOOKKEY'].join('');
const SECRET_LINE = `const key = "${AWS_KEY}";`;
const LOG_PII = ['logger', '.info("welcome", ', 'email)'].join('');

describe('shieldDenialMessage', () => {
  it('blocks a write that introduces a new secret', () => {
    const current = ['export const region = "us-east-1";'].join('\n');
    const proposed = [current, SECRET_LINE].join('\n');
    const message = shieldDenialMessage('src/config.ts', proposed, current);
    expect(message).toContain('aws-access-key');
    expect(message).toContain('src/config.ts');
    expect(message).not.toContain('HOOKKEY'); // redacted
  });

  it('does not block an unrelated edit to a file that already has a finding', () => {
    const current = [SECRET_LINE, 'export const retries = 1;'].join('\n');
    const proposed = [SECRET_LINE, 'export const retries = 3;'].join('\n');
    expect(shieldDenialMessage('src/config.ts', proposed, current)).toBeNull();
  });

  it('treats every finding as introduced when the file does not exist yet', () => {
    expect(shieldDenialMessage('src/new.ts', SECRET_LINE, null)).toContain(
      'aws-access-key',
    );
  });

  it('does not block on non-blocking findings or skipped paths', () => {
    expect(shieldDenialMessage('src/user.ts', LOG_PII, null)).toBeNull();
    expect(shieldDenialMessage('test/fixtures/keys.ts', SECRET_LINE, null)).toBeNull();
  });
});
