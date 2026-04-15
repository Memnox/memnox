import { describe, expect, it } from 'vitest';
import { matchesAny, matchesPattern } from '../src/pattern-matcher';

describe('matchesPattern', () => {
  it('matches exact values case-insensitively', () => {
    expect(matchesPattern('database.delete', 'DATABASE.DELETE')).toBe(true);
    expect(matchesPattern('database.delete', 'database.create')).toBe(false);
  });

  it('matches wildcard suffixes across separators', () => {
    expect(matchesPattern('database.*', 'database.delete')).toBe(true);
    expect(matchesPattern('payment/*', 'payment/api/refund.ts')).toBe(true);
    expect(matchesPattern('payment/*', 'billing/refund.ts')).toBe(false);
  });

  it('matches wildcards in any position', () => {
    expect(matchesPattern('*.delete', 'database.delete')).toBe(true);
    expect(matchesPattern('*', 'anything.at.all')).toBe(true);
  });

  it('treats regex metacharacters in patterns literally', () => {
    expect(matchesPattern('file.write', 'fileXwrite')).toBe(false);
    expect(matchesPattern('a+b', 'a+b')).toBe(true);
  });
});

describe('matchesAny', () => {
  it('matches everything when the pattern list is omitted or empty', () => {
    expect(matchesAny(undefined, 'database.delete')).toBe(true);
    expect(matchesAny([], undefined)).toBe(true);
  });

  it('matches an undefined value only via the bare wildcard', () => {
    expect(matchesAny(['production'], undefined)).toBe(false);
    expect(matchesAny(['*'], undefined)).toBe(true);
  });
});
