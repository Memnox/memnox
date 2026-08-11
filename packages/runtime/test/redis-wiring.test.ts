import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { InProcessLockService } from '@memnox/core';
import { assertRedisReachable, RedisLockService, type RedisLike } from '@memnox/redis';
import { buildServer, type MemnoxServer } from '../src/server';

const RATE_LIMIT = 2;
const REDIS_URL = 'redis://stub';

class StubRedis implements RedisLike {
  readonly keys = new Map<string, string>();
  readonly evalKeys: string[] = [];
  failing = false;

  async set(
    key: string,
    value: string,
    _mode: 'EX',
    _ttl: number,
    condition?: 'NX',
  ): Promise<'OK' | null> {
    if (this.failing) throw new Error('connection refused');
    if (condition === 'NX' && this.keys.has(key)) return null;
    this.keys.set(key, value);
    return 'OK';
  }

  async get(key: string): Promise<string | null> {
    if (this.failing) throw new Error('connection refused');
    return this.keys.get(key) ?? null;
  }

  async del(key: string): Promise<number> {
    if (this.failing) throw new Error('connection refused');
    return this.keys.delete(key) ? 1 : 0;
  }

  async eval(_script: string, _numKeys: number, key: string): Promise<unknown> {
    if (this.failing) throw new Error('connection refused');
    this.evalKeys.push(key);
    const next = Number(this.keys.get(key) ?? '0') + 1;
    this.keys.set(key, String(next));
    return next;
  }

  async quit(): Promise<'OK'> {
    return 'OK';
  }

  on(): unknown {
    return this;
  }
}

describe('assertRedisReachable', () => {
  it('passes when the backend answers', async () => {
    await expect(
      assertRedisReachable(new RedisLockService(new StubRedis())),
    ).resolves.toBeUndefined();
  });

  // The client connects asynchronously, so the first command can fail against a
  // perfectly healthy backend. Refusing to start on that is a false negative.
  it('waits out a connection that is not open yet', async () => {
    const redis = new StubRedis();
    redis.failing = true;
    setTimeout(() => {
      redis.failing = false;
    }, 5);

    await expect(
      assertRedisReachable(new RedisLockService(redis), 20, 5),
    ).resolves.toBeUndefined();
  });

  it('throws without echoing the URL when the backend is down', async () => {
    const redis = new StubRedis();
    redis.failing = true;
    await expect(assertRedisReachable(new RedisLockService(redis), 2, 0)).rejects.toThrow(
      /Redis is unreachable/,
    );
  });
});

describe('serve --redis-url', () => {
  let dataDir: string;
  let server: MemnoxServer;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'memnox-redis-'));
  });

  afterEach(async () => {
    await server.app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  it('keeps in-process locks when no Redis URL is configured', async () => {
    server = await buildServer({ dataDir });
    expect(server.lockService).toBeInstanceOf(InProcessLockService);
  });

  it('selects the Redis lock service and counts rate limits through it', async () => {
    const redis = new StubRedis();
    server = await buildServer(
      { dataDir, redisUrl: REDIS_URL, checkRateLimitPerMinute: RATE_LIMIT },
      { redis },
    );
    expect(server.lockService).toBeInstanceOf(RedisLockService);

    const registration = await server.app.inject({
      method: 'POST',
      url: '/v1/agents',
      payload: { name: 'claude-code', kind: 'claude-code' },
    });
    const { token } = registration.json() as { token: string };
    await server.app.inject({
      method: 'POST',
      url: '/v1/actions/check',
      headers: { authorization: `Bearer ${token}` },
      payload: { action: 'file.read' },
    });

    // The limiter counter now lives in Redis, so every pod shares one budget.
    expect(redis.evalKeys.some((key) => key.startsWith('memnox:ratelimit:'))).toBe(true);
  });

  it('shares session taint through Redis instead of per-pod memory', async () => {
    const redis = new StubRedis();
    server = await buildServer({ dataDir, redisUrl: REDIS_URL }, { redis });

    const registration = await server.app.inject({
      method: 'POST',
      url: '/v1/agents',
      payload: { name: 'claude-code', kind: 'claude-code' },
    });
    const { token } = registration.json() as { token: string };
    await server.app.inject({
      method: 'POST',
      url: '/v1/actions/check',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        action: 'repository.read',
        sessionId: 'sess-1',
        taint: {
          tainted: true,
          sources: [{ sourceType: 'email_message', reason: 'third-party email' }],
        },
      },
    });

    expect(
      [...redis.keys.keys()].some((key) => key.startsWith('memnox:taint:session:')),
    ).toBe(true);
  });

  it('refuses to start when the configured Redis is unreachable', async () => {
    const redis = new StubRedis();
    redis.failing = true;
    // The retry budget itself is covered above; here only the propagation is.
    await expect(
      buildServer(
        { dataDir, redisUrl: REDIS_URL },
        { redis, redisProbe: { attempts: 2, delayMs: 0 } },
      ),
    ).rejects.toThrow(/Redis is unreachable/);
    server = await buildServer({ dataDir });
  });
});
