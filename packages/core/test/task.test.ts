import { describe, expect, it } from 'vitest';
import { compareDeclaredScope, SCOPE_MATCH, type DeclaredScope } from '../src/index';

/** Stand-in for the engine's glob matcher; scope is compared, never judged. */
const matches = (patterns: readonly string[], value: string): boolean =>
  patterns.some((pattern) =>
    pattern.endsWith('**') ? value.startsWith(pattern.slice(0, -2)) : pattern === value,
  );

const AUTH_TASK: DeclaredScope = {
  paths: ['src/auth/**'],
  environments: ['development'],
};

describe('compareDeclaredScope', () => {
  it('names the dimension that fell outside, so the refusal can say which', () => {
    const comparison = compareDeclaredScope(AUTH_TASK, { path: '.env' }, matches);

    expect(comparison.match).toBe(SCOPE_MATCH.OUT_OF_SCOPE);
    expect(comparison.dimension).toBe('path');
    expect(comparison.actual).toBe('.env');
  });

  it('is in scope when every declared dimension the request touches agrees', () => {
    const comparison = compareDeclaredScope(
      AUTH_TASK,
      { path: 'src/auth/session.ts', environment: 'development' },
      matches,
    );

    expect(comparison.match).toBe(SCOPE_MATCH.IN_SCOPE);
  });

  it('reports undeclared rather than in scope when nothing was declared about it', () => {
    const comparison = compareDeclaredScope({}, { path: 'src/auth/session.ts' }, matches);

    expect(comparison.match).toBe(SCOPE_MATCH.UNDECLARED);
  });

  it('reports undeclared when the request says nothing about a declared dimension', () => {
    // A missing field is a silence, not a match: guessing here would be a classifier.
    const comparison = compareDeclaredScope(AUTH_TASK, {}, matches);

    expect(comparison.match).toBe(SCOPE_MATCH.UNDECLARED);
  });
});
