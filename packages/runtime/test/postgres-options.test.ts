import { describe, expect, it } from 'vitest';
import { postgresOptionsFromEnv } from '@memnox/postgres';

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
