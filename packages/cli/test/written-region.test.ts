import { describe, expect, it } from 'vitest';
import { regionFrom, symbolIn } from '@memnox/core';

/**
 * What a session is about to write, read off the change rather than declared.
 *
 * Git already computes both halves and puts them in the hunk header, so this
 * needs no parser and no syntax tree. Everything unreadable falls back to
 * nothing, and nothing already means the whole file to every lease ever taken.
 */

const diff = (...hunks: string[]): string =>
  [
    'diff --git a/x.ts b/x.ts',
    'index 1..2 100644',
    '--- a/x.ts',
    '+++ b/x.ts',
    ...hunks,
  ].join('\n');

describe('the lines a change touches', () => {
  it('reads the new-file side, because that is where the session writes', () => {
    const region = regionFrom(diff('@@ -40,7 +44,9 @@ '));

    expect(region.lines).toEqual([{ from: 44, to: 52 }]);
  });

  it('treats a header with no count as one line', () => {
    const region = regionFrom(diff('@@ -6 +6 @@ '));

    expect(region.lines).toEqual([{ from: 6, to: 6 }]);
  });

  it('claims the row a pure deletion happened at', () => {
    /* Two sessions deleting next to each other still have to meet. */
    const region = regionFrom(diff('@@ -10,3 +9,0 @@ '));

    expect(region.lines).toEqual([{ from: 9, to: 9 }]);
  });

  it('reads every hunk in one diff', () => {
    const region = regionFrom(diff('@@ -1 +1,2 @@ ', '@@ -50,2 +60,4 @@ '));

    expect(region.lines).toEqual([
      { from: 1, to: 2 },
      { from: 60, to: 63 },
    ]);
  });

  it('knows nothing about a diff that is not one', () => {
    /* A new file, a binary file, or a directory that is not a repository. All
       of them answer nothing, and nothing is the whole file. */
    expect(regionFrom('')).toEqual({ lines: [], symbols: [] });
    expect(regionFrom('fatal: not a git repository')).toEqual({
      lines: [],
      symbols: [],
    });
  });
});

describe('the function a change is inside', () => {
  it('reads the name git already put in the header', () => {
    const region = regionFrom(
      diff('@@ -6 +6,2 @@ export function retryCharge(attempt: number): boolean {'),
    );

    expect(region.symbols).toEqual(['retryCharge']);
  });

  it('names each function once, however many hunks are in it', () => {
    const region = regionFrom(
      diff(
        '@@ -6 +6,2 @@ function retryCharge(a) {',
        '@@ -20 +21,2 @@ function retryCharge(a) {',
      ),
    );

    expect(region.symbols).toEqual(['retryCharge']);
  });

  it('says nothing where git had no context to give', () => {
    /* A language git has no pattern for. Inventing a name here would put one on
       a claim that nothing in the file is called. */
    expect(regionFrom(diff('@@ -6 +6,2 @@ ')).symbols).toEqual([]);
    expect(regionFrom(diff('@@ -6 +6,2 @@ }')).symbols).toEqual([]);
  });
});

describe('reading a name out of a declaration', () => {
  it.each([
    ['export function retryCharge(attempt: number): boolean {', 'retryCharge'],
    ['  async retryCharge(attempt) {', 'retryCharge'],
    ['def retry_charge(self, attempt):', 'retry_charge'],
    ['func (s *Service) RetryCharge() error {', 'RetryCharge'],
    ['public static void retryCharge(int attempt) {', 'retryCharge'],
    ['fn retry_charge(attempt: u32) -> bool {', 'retry_charge'],
    ['class PaymentService {', 'PaymentService'],
    ['interface PaymentPort {', 'PaymentPort'],
    ['type Invoice struct {', 'Invoice'],
  ])('reads %s as %s', (context, expected) => {
    expect(symbolIn(context)).toBe(expected);
  });

  it('skips the receiver in a Go method, because func is never a name', () => {
    expect(symbolIn('func (s *Service) RetryCharge() error {')).toBe('RetryCharge');
  });

  it('answers nothing for a brace or a blank', () => {
    expect(symbolIn('}')).toBeNull();
    expect(symbolIn('   ')).toBeNull();
    expect(symbolIn('')).toBeNull();
  });
});
