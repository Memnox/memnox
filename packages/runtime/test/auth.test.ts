import { describe, expect, it, vi, type Mock } from 'vitest';
import { API_ROLE, SILENT_LOGGER, type Logger } from '@memnox/core';
import { isAuthorizedFor, resolveApiRole, resolveLocalMode } from '../src/auth';
import { resolveConfig } from '../src/config';

function recordingLogger(): Logger & { warn: Mock<Logger['warn']> } {
  return { ...SILENT_LOGGER, warn: vi.fn<Logger['warn']>() };
}

describe('api auth', () => {
  it('refuses a keyless runtime that never opted into local mode', () => {
    const config = resolveConfig({});
    expect(resolveApiRole(null, config)).toBeNull();
  });

  it('treats a keyless loopback runtime as open local mode', () => {
    const config = resolveLocalMode(resolveConfig({ host: '127.0.0.1' }), SILENT_LOGGER);
    expect(config.allowLocalAdmin).toBe(true);
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

describe('local mode', () => {
  it('grants loopback admin and says so', () => {
    const logger = recordingLogger();
    const config = resolveLocalMode(resolveConfig({ host: '127.0.0.1' }), logger);
    expect(config.allowLocalAdmin).toBe(true);
    expect(logger.warn).toHaveBeenCalledOnce();
  });

  it('refuses to start keyless on a routable host', () => {
    expect(() =>
      resolveLocalMode(resolveConfig({ host: '0.0.0.0' }), SILENT_LOGGER),
    ).toThrow(/routable/);
  });

  it('allows a routable keyless host only when explicitly asked', () => {
    const config = resolveLocalMode(
      resolveConfig({ host: '0.0.0.0', allowLocalAdmin: true }),
      SILENT_LOGGER,
    );
    expect(resolveApiRole(null, config)).toBe(API_ROLE.ADMIN);
  });

  it('leaves a keyed runtime closed regardless of host', () => {
    const config = resolveLocalMode(
      resolveConfig({ host: '0.0.0.0', adminToken: 'set' }),
      SILENT_LOGGER,
    );
    expect(config.allowLocalAdmin).toBe(false);
    expect(resolveApiRole(null, config)).toBeNull();
  });
});
