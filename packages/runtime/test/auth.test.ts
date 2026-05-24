import { describe, expect, it } from 'vitest';
import { API_ROLE } from '@memnox/core';
import { isAuthorizedFor, resolveApiRole } from '../src/auth';
import { resolveConfig } from '../src/config';

describe('api auth', () => {
  it('treats a runtime with no keys as open local mode', () => {
    const config = resolveConfig({});
    expect(resolveApiRole(null, config)).toBe(API_ROLE.ADMIN);
  });

  it('maps tokens to their configured roles', () => {
    const config = resolveConfig({
      apiKeys: [
        { token: 'viewer-token', role: API_ROLE.VIEWER },
        { token: 'approver-token', role: API_ROLE.APPROVER },
      ],
    });
    expect(resolveApiRole('viewer-token', config)).toBe(API_ROLE.VIEWER);
    expect(resolveApiRole('unknown', config)).toBeNull();
    expect(resolveApiRole(null, config)).toBeNull();
  });

  it('enforces the role hierarchy', () => {
    const config = resolveConfig({
      apiKeys: [
        { token: 'viewer-token', role: API_ROLE.VIEWER },
        { token: 'approver-token', role: API_ROLE.APPROVER },
        { token: 'admin-token', role: API_ROLE.ADMIN },
      ],
    });
    expect(isAuthorizedFor('viewer-token', config, API_ROLE.APPROVER)).toBe(false);
    expect(isAuthorizedFor('approver-token', config, API_ROLE.VIEWER)).toBe(true);
    expect(isAuthorizedFor('approver-token', config, API_ROLE.ADMIN)).toBe(false);
    expect(isAuthorizedFor('admin-token', config, API_ROLE.APPROVER)).toBe(true);
  });

  it('keeps the legacy adminToken working as an admin key', () => {
    const config = resolveConfig({ adminToken: 'legacy' });
    expect(resolveApiRole('legacy', config)).toBe(API_ROLE.ADMIN);
    expect(resolveApiRole(null, config)).toBeNull();
  });
});
