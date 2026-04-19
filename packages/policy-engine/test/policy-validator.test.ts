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
