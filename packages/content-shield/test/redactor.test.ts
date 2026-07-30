import { describe, expect, it } from 'vitest';
import { REDACTION_MASK, redactSecrets, scanContent, isBlocking } from '../src/index';

/** Secrets are assembled at runtime so no test file ever holds one literally. */
const awsKey = ['AKIA', 'ABCDEFGHIJKLMNOP'].join('');
const githubToken = ['ghp_', 'a'.repeat(36)].join('');
const keyFence = (edge: string): string =>
  ['-----', edge, ' RSA PRIVATE ', 'KEY', '-----'].join('');
const cardGroups = ['4539', '5787', '6362', '1486'];
const spacedCard = cardGroups.join(' ');

describe('redactSecrets', () => {
  it('masks a key in place and leaves the rest of the text alone', () => {
    const result = redactSecrets(`aws configure set key ${awsKey} --profile prod`);

    expect(result.text).not.toContain(awsKey);
    expect(result.text).toContain('--profile prod');
    expect(result.redactions).toEqual([{ rule: 'aws-access-key', count: 1 }]);
  });

  it('reports nothing to redact when there is no secret', () => {
    const result = redactSecrets('git status --short');

    expect(result.text).toBe('git status --short');
    expect(result.redactions).toEqual([]);
  });

  it('comes back clean when re-scanned, or redaction would block its own call', () => {
    const masked = redactSecrets(
      [`export TOKEN=${githubToken}`, `api_key = "${awsKey}"`].join('\n'),
    );

    const remaining = scanContent('memnox-argument', masked.text).filter(isBlocking);

    expect(remaining).toEqual([]);
    expect(masked.text).toContain(REDACTION_MASK);
  });

  it('drops a private key body outright — masking its header keeps nothing safe', () => {
    const body = 'MIIEowIBAAKCAQEArandomlookingbase64';
    const key = [keyFence('BEGIN'), body, keyFence('END'), 'trailing note'].join('\n');

    const result = redactSecrets(key);

    expect(result.text).not.toContain(body);
    expect(result.text).toContain('trailing note');
    expect(result.redactions[0]?.rule).toBe('private-key-block');
  });

  it('masks a payment card wherever its digits are spaced', () => {
    const result = redactSecrets(`charge ${spacedCard} now`);

    expect(result.text).not.toContain(cardGroups[0]);
    expect(result.text).toContain('charge');
    expect(result.redactions[0]?.rule).toBe('credit-card-number');
  });

  it('leaves a placeholder assignment untouched', () => {
    const result = redactSecrets('API_TOKEN=${API_TOKEN}');

    expect(result.text).toBe('API_TOKEN=${API_TOKEN}');
    expect(result.redactions).toEqual([]);
  });

  it('counts every occurrence, not just the first', () => {
    const result = redactSecrets([`a ${awsKey}`, `b ${awsKey}`].join('\n'));

    expect(result.redactions).toEqual([{ rule: 'aws-access-key', count: 2 }]);
  });
});
