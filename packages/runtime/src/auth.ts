import { timingSafeEqual } from 'node:crypto';
import type { ApiRole, Logger } from '@memnox/core';
import { API_ROLE, roleSatisfies } from '@memnox/core';
import type { RuntimeConfig } from './config';
import { hashToken } from './token';

const LOCAL_MODE_PRINCIPAL = 'local-admin';
const PRINCIPAL_FINGERPRINT_LENGTH = 8;
const UNKNOWN_ROLE = 'unknown';
/** Addresses nothing off this machine can reach, so a keyless runtime stays private. */
const LOOPBACK_HOSTS: readonly string[] = ['127.0.0.1', '::1', 'localhost'];

/** Compared as digests: `===` leaks how much of a secret was right via timing. */
function credentialEquals(candidate: string, expected: string): boolean {
  return timingSafeEqual(
    Buffer.from(hashToken(candidate), 'hex'),
    Buffer.from(hashToken(expected), 'hex'),
  );
}

function hasManagementKeys(config: RuntimeConfig): boolean {
  return config.apiKeys.length > 0 || Boolean(config.adminToken);
}

/** Keyless local mode is safe only when nothing else can reach the port. */
export function resolveLocalMode(config: RuntimeConfig, logger: Logger): RuntimeConfig {
  if (hasManagementKeys(config) || config.allowLocalAdmin) return config;
  if (!LOOPBACK_HOSTS.includes(config.host)) {
    throw new Error(
      `refusing to start: no adminToken or apiKeys configured and host "${config.host}" is routable. ` +
        'Set --admin-token (or $MEMNOX_ADMIN_TOKEN), or pass --allow-local-admin to accept an unauthenticated runtime.',
    );
  }
  logger.warn('no management keys configured — admin routes are open on loopback');
  return { ...config, allowLocalAdmin: true };
}

/** A runtime in local mode has no keys, so management requests are already trusted. */
export function resolveApiRole(
  token: string | null,
  config: RuntimeConfig,
): ApiRole | null {
  if (!hasManagementKeys(config)) return config.allowLocalAdmin ? API_ROLE.ADMIN : null;
  if (!token) return null;
  if (config.adminToken && credentialEquals(token, config.adminToken))
    return API_ROLE.ADMIN;
  const match = config.apiKeys.find((key) => credentialEquals(token, key.token));
  return match === undefined ? null : match.role;
}

/** `admin` says what a key may do, never to whom — this is the missing half. */
export function isScopedToWorkspace(
  token: string | null,
  config: RuntimeConfig,
  workspace: string,
): boolean {
  if (!hasManagementKeys(config)) return true;
  // A keyed runtime with no credential presented is scoped to nothing.
  if (token === null) return false;
  if (config.adminToken && credentialEquals(token, config.adminToken)) return true;
  const match = config.apiKeys.find((key) => credentialEquals(token, key.token));
  if (match === undefined) return false;
  return match.workspace === undefined || match.workspace === workspace;
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
