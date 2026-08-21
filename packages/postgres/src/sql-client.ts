import type { ConnectionOptions } from 'node:tls';
import { Pool } from 'pg';

/** Fits one instance; raise it per instance when running behind PgBouncer. */
const DEFAULT_POOL_MAX = 20;
const DEFAULT_POOL_MIN = 2;
const IDLE_TIMEOUT_MS = 30_000;
const CONNECTION_TIMEOUT_MS = 5_000;
/** Keeps connections alive through NAT and firewall idle timeouts. */
const KEEPALIVE_DELAY_MS = 10_000;

export interface SqlRow {
  [column: string]: unknown;
}

/** The slice of a pg Pool the stores need — injectable so tests run against pg-mem. */
export interface SqlClient {
  query(text: string, params?: unknown[]): Promise<{ rows: SqlRow[] }>;
  end(): Promise<void>;
}

export interface PostgresOptions {
  poolMax?: number;
  poolMin?: number;
  /** Managed Postgres (RDS, Supabase, Neon) refuses plaintext connections. */
  ssl?: boolean;
  /** Encryption without authentication: stops a passive listener, not an active one. */
  sslAllowUnverified?: boolean;
  /** A private CA's certificate, for a database not signed by a public root. */
  sslRootCert?: string;
  /** Names the connection so an operator can tell which instance owns it. */
  applicationName?: string;
}

/** Verifying by default is the point; `rejectUnauthorized: false` was the old behaviour. */
function sslSettings(
  options: PostgresOptions,
): { ssl: ConnectionOptions } | Record<string, never> {
  if (options.ssl !== true) return {};
  if (options.sslRootCert !== undefined) {
    return { ssl: { rejectUnauthorized: true, ca: options.sslRootCert } };
  }
  return { ssl: { rejectUnauthorized: options.sslAllowUnverified !== true } };
}

/** No `statement_timeout`: PgBouncer rejects it at startup. Set it on the role instead. */
export function connectPostgres(
  databaseUrl: string,
  options: PostgresOptions = {},
): SqlClient {
  return new Pool({
    connectionString: databaseUrl,
    max: options.poolMax ?? DEFAULT_POOL_MAX,
    min: options.poolMin ?? DEFAULT_POOL_MIN,
    idleTimeoutMillis: IDLE_TIMEOUT_MS,
    connectionTimeoutMillis: CONNECTION_TIMEOUT_MS,
    keepAlive: true,
    keepAliveInitialDelayMillis: KEEPALIVE_DELAY_MS,
    application_name: options.applicationName ?? 'memnox',
    ...sslSettings(options),
  });
}

/** Reads pool settings from the environment, falling back to the defaults above. */
export function postgresOptionsFromEnv(
  env: NodeJS.ProcessEnv,
  prefix: string,
): PostgresOptions {
  const positive = (name: string): number | undefined => {
    const raw = env[`${prefix}${name}`];
    if (raw === undefined) return undefined;
    const parsed = Number(raw);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
  };
  const poolMax = positive('POOL_MAX');
  const poolMin = positive('POOL_MIN');
  const applicationName = env[`${prefix}APP_NAME`];
  const sslRootCert = env[`${prefix}SSL_ROOT_CERT`];

  return {
    ...(poolMax === undefined ? {} : { poolMax }),
    ...(poolMin === undefined ? {} : { poolMin }),
    ...(env[`${prefix}SSL`] === 'true' ? { ssl: true } : {}),
    // Opt-in and awkward to type on purpose: it downgrades the connection to
    // unauthenticated encryption, so it should never be reached for absently.
    ...(env[`${prefix}SSL_ALLOW_UNVERIFIED`] === 'true'
      ? { sslAllowUnverified: true }
      : {}),
    ...(sslRootCert === undefined ? {} : { sslRootCert }),
    ...(applicationName === undefined ? {} : { applicationName }),
  };
}
