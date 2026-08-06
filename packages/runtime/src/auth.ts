import type { ApiRole, Logger } from '@memnox/core';
import { API_ROLE, roleSatisfies } from '@memnox/core';
import type { RuntimeConfig } from './config';
import { hashToken } from './token';

const LOCAL_MODE_PRINCIPAL = 'local-admin';
const PRINCIPAL_FINGERPRINT_LENGTH = 8;
const UNKNOWN_ROLE = 'unknown';
/** Addresses nothing off this machine can reach, so a keyless runtime stays private. */
const LOOPBACK_HOSTS: readonly string[] = ['127.0.0.1', '::1', 'localhost'];

function hasManagementKeys(config: RuntimeConfig): boolean {
  return config.apiKeys.length > 0 || Boolean(config.adminToken);
}

/**
 * Keyless local mode is only safe when nothing else can reach the port: a
 * routable bind with no credentials serves every admin route to the network.
 */
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

/**
 * Resolves the role behind a bearer token. A runtime that opted into local mode
 * has no keys, so every management request is treated as admin.
 */
export function resolveApiRole(
  token: string | null,
  config: RuntimeConfig,
): ApiRole | null {
  if (!hasManagementKeys(config)) return config.allowLocalAdmin ? API_ROLE.ADMIN : null;
  if (!token) return null;
  if (config.adminToken && token === config.adminToken) return API_ROLE.ADMIN;
  const match = config.apiKeys.find((key) => key.token === token);
  return match === undefined ? null : match.role;
}

/**
 * Whether this credential may manage this workspace.
 *
 * The check the role alone cannot make: `admin` says what a key may do, never
 * to whom. A key that names a workspace is confined to it; one that names none
 * is a single-tenant key and reaches everything, which is what it already did.
 *
 * Local mode has no keys and therefore no scope — it is a loopback runtime with
 * admin routes deliberately open, and pretending otherwise here would suggest a
 * boundary that is not there.
 */
export function isScopedToWorkspace(
  token: string | null,
  config: RuntimeConfig,
  workspace: string,
): boolean {
  if (!hasManagementKeys(config)) return true;
  if (config.adminToken && token === config.adminToken) return true;
  const match = config.apiKeys.find((key) => key.token === token);
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
