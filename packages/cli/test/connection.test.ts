import { describe, expect, it } from 'vitest';
import {
  describeConnectionFailure,
  ENV_AGENT_TOKEN,
  ENV_RUNTIME_URL,
  resolveConnection,
} from '../src/connection';
import { DEFAULT_BASE_URL } from '../src/defaults';

const STORED = { token: 'stored-token', url: 'http://127.0.0.1:9000' };

describe('resolveConnection', () => {
  it('falls back to the token memnox setup stored on disk', () => {
    const resolved = resolveConnection({}, STORED, {});

    expect(resolved.token).toBe('stored-token');
    expect(resolved.url).toBe('http://127.0.0.1:9000');
    expect(resolved.tokenSource).toBe('config');
  });

  it('lets the environment override the stored token — that is how CI passes one', () => {
    const resolved = resolveConnection({}, STORED, { [ENV_AGENT_TOKEN]: 'ci-token' });

    expect(resolved.token).toBe('ci-token');
    expect(resolved.tokenSource).toBe('environment');
  });

  it('lets an explicit flag beat both', () => {
    const resolved = resolveConnection({ token: 'flag-token' }, STORED, {
      [ENV_AGENT_TOKEN]: 'ci-token',
    });

    expect(resolved.token).toBe('flag-token');
    expect(resolved.tokenSource).toBe('flag');
  });

  it('resolves the url with the same precedence', () => {
    expect(resolveConnection({ url: 'http://flag' }, STORED, {}).url).toBe('http://flag');
    expect(resolveConnection({}, STORED, { [ENV_RUNTIME_URL]: 'http://env' }).url).toBe(
      'http://env',
    );
    expect(resolveConnection({}, {}, {}).url).toBe(DEFAULT_BASE_URL);
  });

  it('reports no token rather than inventing one', () => {
    const resolved = resolveConnection({}, {}, {});

    expect(resolved.token).toBeUndefined();
    expect(resolved.tokenSource).toBeUndefined();
  });
});

describe('describeConnectionFailure', () => {
  it('names the address and the fix when nothing is listening', () => {
    const message = describeConnectionFailure(
      new Error('fetch failed'),
      'http://127.0.0.1:7466',
    );

    expect(message).toContain('http://127.0.0.1:7466');
    expect(message).toContain('memnox serve');
  });

  it('reads the cause, which is where undici hides ECONNREFUSED', () => {
    const err = new Error('something broke', { cause: new Error('ECONNREFUSED') });

    expect(describeConnectionFailure(err, 'http://x')).toContain('memnox serve');
  });

  it('leaves unrelated failures alone so the real message survives', () => {
    expect(
      describeConnectionFailure(new Error('401 unauthorized'), 'http://x'),
    ).toBeNull();
  });
});
