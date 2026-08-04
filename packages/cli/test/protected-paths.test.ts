import { describe, expect, it } from 'vitest';
import { detectProtectedPaths } from '../src/protected-paths';

describe('detectProtectedPaths', () => {
  it('protects the sensitive directories a repository actually has', () => {
    const patterns = detectProtectedPaths([
      'src/payment/charge.ts',
      'src/auth/session.ts',
      'src/util/format.ts',
    ]);

    expect(patterns).toEqual(['*auth/*', '*payment/*']);
  });

  it('returns nothing when no sensitive directory is present', () => {
    // A pattern matching nothing reads in `memnox status` as a guard that is
    // on, and it is not.
    expect(detectProtectedPaths(['src/index.ts', 'src/util/format.ts'])).toEqual([]);
  });

  it('matches a directory, not a file whose name merely starts the same way', () => {
    expect(detectProtectedPaths(['src/author.ts', 'src/authority/rules.ts'])).toEqual([]);
  });

  it('does not care how the directory was capitalised', () => {
    expect(detectProtectedPaths(['src/Auth/Session.ts'])).toEqual(['*auth/*']);
  });

  it('names each directory once however many files it holds', () => {
    const patterns = detectProtectedPaths([
      'billing/a.ts',
      'billing/b.ts',
      'billing/nested/c.ts',
    ]);

    expect(patterns).toEqual(['*billing/*']);
  });
});
