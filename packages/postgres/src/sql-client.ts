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
  /** Names the connection so an operator can tell which instance owns it. */
  applicationName?: string;
}

/**
 * Deliberately sets no `statement_timeout`: pg sends it as a startup parameter
 * and PgBouncer's transaction pooling rejects it. Set it on the database role.
 */
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
    ...(options.ssl === true ? { ssl: { rejectUnauthorized: false } } : {}),
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

  return {
    ...(poolMax === undefined ? {} : { poolMax }),
    ...(poolMin === undefined ? {} : { poolMin }),
    ...(env[`${prefix}SSL`] === 'true' ? { ssl: true } : {}),
    ...(applicationName === undefined ? {} : { applicationName }),
  };
}
