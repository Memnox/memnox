import type { ApiRole } from '@memnox/core';
import { API_ROLE, roleSatisfies } from '@memnox/core';
import type { RuntimeConfig } from './config';
import { hashToken } from './token';

const LOCAL_MODE_PRINCIPAL = 'local-admin';
const PRINCIPAL_FINGERPRINT_LENGTH = 8;
const UNKNOWN_ROLE = 'unknown';

/**
 * Resolves the role behind a bearer token. A runtime with no keys configured
 * is in local mode: every management request is treated as admin.
 */
export function resolveApiRole(
  token: string | null,
  config: RuntimeConfig,
): ApiRole | null {
  const hasKeys = config.apiKeys.length > 0 || Boolean(config.adminToken);
  if (!hasKeys) return API_ROLE.ADMIN;
  if (!token) return null;
  if (config.adminToken && token === config.adminToken) return API_ROLE.ADMIN;
  const match = config.apiKeys.find((key) => key.token === token);
  return match === undefined ? null : match.role;
}

export function isAuthorizedFor(
  token: string | null,
  config: RuntimeConfig,
  required: ApiRole,
): boolean {
  const role = resolveApiRole(token, config);
  return role !== null && roleSatisfies(role, required);
}

/** Stable audit-trail label for the caller — role plus key fingerprint, never the credential. */
export function resolveApiPrincipal(token: string | null, config: RuntimeConfig): string {
  if (!token) return LOCAL_MODE_PRINCIPAL;
  const role = resolveApiRole(token, config) ?? UNKNOWN_ROLE;
  return `${role}:${hashToken(token).slice(0, PRINCIPAL_FINGERPRINT_LENGTH)}`;
}
