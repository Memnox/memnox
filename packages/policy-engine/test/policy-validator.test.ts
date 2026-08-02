import { describe, expect, it } from 'vitest';
import { PolicyValidationError, validatePolicyDocument } from '../src/policy-validator';

const VALID_DOCUMENT = {
  version: 1,
  policies: [
    {
      name: 'production-database-protection',
      match: { actions: ['database.delete'], environments: ['production'] },
      decision: { effect: 'block', reason: 'No AI database deletion' },
    },
  ],
};

describe('validatePolicyDocument', () => {
  it('accepts a valid document', () => {
    const doc = validatePolicyDocument(VALID_DOCUMENT);
    expect(doc.policies).toHaveLength(1);
    expect(doc.policies[0]?.name).toBe('production-database-protection');
  });

  it('rejects unknown effects', () => {
    const invalid = {
      version: 1,
      policies: [{ name: 'x', match: { actions: ['a'] }, decision: { effect: 'maybe' } }],
    };
    expect(() => validatePolicyDocument(invalid)).toThrow(PolicyValidationError);
  });

  it('requires approvers when the effect is require_approval', () => {
    const invalid = {
      version: 1,
      policies: [
        {
          name: 'x',
          match: { actions: ['a'] },
          decision: { effect: 'require_approval' },
        },
      ],
    };
    expect(() => validatePolicyDocument(invalid)).toThrow(/approvers/);
  });

  it('rejects duplicate policy names and lists every issue at once', () => {
    const invalid = {
      version: 2,
      policies: [
        { name: 'dup', match: { actions: ['a'] }, decision: { effect: 'block' } },
        { name: 'dup', match: { actions: ['b'] }, decision: { effect: 'block' } },
      ],
    };
    try {
      validatePolicyDocument(invalid);
      expect.unreachable('should have thrown');
    } catch (err) {
      const issues = (err as PolicyValidationError).issues;
      expect(issues.some((issue) => issue.includes('version'))).toBe(true);
      expect(issues.some((issue) => issue.includes('duplicate'))).toBe(true);
    }
  });

  it('rejects non-object input', () => {
    expect(() => validatePolicyDocument('nope')).toThrow(PolicyValidationError);
  });
});

describe('project declaration', () => {
  const doc = (project: unknown): Record<string, unknown> => ({
    version: 1,
    project,
    policies: [],
  });

  it('accepts a declared project so several repos can share one scope', () => {
    expect(validatePolicyDocument(doc('acme-checkout')).project).toBe('acme-checkout');
  });

  it('trims it, so whitespace cannot split one project into two', () => {
    expect(validatePolicyDocument(doc('  acme-checkout  ')).project).toBe(
      'acme-checkout',
    );
  });

  it('leaves it unset when absent', () => {
    expect(validatePolicyDocument({ version: 1, policies: [] }).project).toBeUndefined();
  });

  it('rejects a blank project rather than scoping to an empty name', () => {
    expect(() => validatePolicyDocument(doc('   '))).toThrow(
      /"project" must be a non-empty string/,
    );
  });

  it('rejects a non-string project', () => {
    expect(() => validatePolicyDocument(doc(42))).toThrow(
      /"project" must be a non-empty string/,
    );
  });
});
