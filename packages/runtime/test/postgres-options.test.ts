import { describe, expect, it } from 'vitest';
import {
  connectPostgres,
  postgresOptionsFromEnv,
  type PostgresOptions,
} from '@memnox/postgres';

const read = (env: Record<string, string>) =>
  postgresOptionsFromEnv(env as NodeJS.ProcessEnv, 'MEMNOX_DB_');

describe('postgresOptionsFromEnv', () => {
  it('leaves everything to the defaults when nothing is set', () => {
    expect(read({})).toEqual({});
  });

  it('reads pool bounds', () => {
    expect(read({ MEMNOX_DB_POOL_MAX: '100', MEMNOX_DB_POOL_MIN: '5' })).toEqual({
      poolMax: 100,
      poolMin: 5,
    });
  });

  // A managed database refuses plaintext; the flag must be explicit, not guessed.
  it('enables SSL only on an exact "true"', () => {
    expect(read({ MEMNOX_DB_SSL: 'true' })).toEqual({ ssl: true });
    expect(read({ MEMNOX_DB_SSL: 'false' })).toEqual({});
    expect(read({ MEMNOX_DB_SSL: '1' })).toEqual({});
  });

  // Unverified TLS is encryption without authentication, so it is opt-in and
  // never inferred from SSL being on.
  it('accepts an unverified certificate only when asked explicitly', () => {
    expect(
      read({ MEMNOX_DB_SSL: 'true', MEMNOX_DB_SSL_ALLOW_UNVERIFIED: 'true' }),
    ).toEqual({
      ssl: true,
      sslAllowUnverified: true,
    });
    expect(
      read({ MEMNOX_DB_SSL: 'true', MEMNOX_DB_SSL_ALLOW_UNVERIFIED: 'false' }),
    ).toEqual({
      ssl: true,
    });
  });

  it('reads a private CA certificate', () => {
    expect(read({ MEMNOX_DB_SSL: 'true', MEMNOX_DB_SSL_ROOT_CERT: 'PEM' })).toEqual({
      ssl: true,
      sslRootCert: 'PEM',
    });
  });

  it('names the connection for whoever is reading pg_stat_activity', () => {
    expect(read({ MEMNOX_DB_APP_NAME: 'memnox-prod-3' })).toEqual({
      applicationName: 'memnox-prod-3',
    });
  });

  // A typo must fall back to a working default, not a zero-size pool.
  it('ignores values that are not positive numbers', () => {
    expect(read({ MEMNOX_DB_POOL_MAX: 'ten' })).toEqual({});
    expect(read({ MEMNOX_DB_POOL_MAX: '0' })).toEqual({});
    expect(read({ MEMNOX_DB_POOL_MAX: '-5' })).toEqual({});
  });

  it('reads only its own prefix', () => {
    expect(
      postgresOptionsFromEnv(
        { MEMNOX_CLOUD_DB_POOL_MAX: '50' } as NodeJS.ProcessEnv,
        'MEMNOX_DB_',
      ),
    ).toEqual({});
  });
});

/** The pool resolves lazily, so constructing one opens no socket. */
function sslOf(options: PostgresOptions): unknown {
  const pool = connectPostgres(
    'postgres://user@db.test:5432/memnox',
    options,
  ) as unknown as {
    options: { ssl?: unknown };
  };
  return pool.options.ssl;
}

describe('connectPostgres, transport security', () => {
  it('sends nothing about TLS when SSL is off', () => {
    expect(sslOf({})).toBeUndefined();
  });

  /* The regression this guards: `rejectUnauthorized: false` used to be
     unconditional, which authenticates no one — anything that can answer for
     the database's address reads and rewrites every row, credentials included. */
  it('verifies the certificate by default', () => {
    expect(sslOf({ ssl: true })).toEqual({ rejectUnauthorized: true });
  });

  it('stops verifying only when the deployment says so', () => {
    expect(sslOf({ ssl: true, sslAllowUnverified: true })).toEqual({
      rejectUnauthorized: false,
    });
  });

  it('verifies against a private CA when one is given', () => {
    expect(sslOf({ ssl: true, sslRootCert: 'PEM' })).toEqual({
      rejectUnauthorized: true,
      ca: 'PEM',
    });
  });

  // A private CA is an answer to "who do I trust", not "trust nobody".
  it('keeps verifying against a private CA even if unverified was also set', () => {
    expect(sslOf({ ssl: true, sslRootCert: 'PEM', sslAllowUnverified: true })).toEqual({
      rejectUnauthorized: true,
      ca: 'PEM',
    });
  });
});
