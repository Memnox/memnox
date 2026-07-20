import { describe, expect, it } from 'vitest';
import { InProcessLockService } from '@memnox/core';
import { RedisLockService, type RedisLike } from '../src/redis-lock.service';

class StubRedis implements RedisLike {
  keys = new Map<string, string>();
  failing = false;
  evalCalls: Array<{ key: string; ttl: string }> = [];

  async set(
    key: string,
    value: string,
    _mode: 'EX',
    _ttl: number,
    _condition: 'NX',
  ): Promise<'OK' | null> {
    if (this.failing) throw new Error('connection refused');
    if (this.keys.has(key)) return null;
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

  async eval(
    _script: string,
    _numKeys: number,
    key: string,
    ttl: string,
  ): Promise<unknown> {
    if (this.failing) throw new Error('connection refused');
    this.evalCalls.push({ key, ttl });
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

describe('RedisLockService', () => {
  it('acquires a lock once and releases it', async () => {
    const redis = new StubRedis();
    const locks = new RedisLockService(redis);
    expect(await locks.acquireLock('memnox:job:lock', 60)).toBe(true);
    expect(await locks.acquireLock('memnox:job:lock', 60)).toBe(false);
    await locks.releaseLock('memnox:job:lock');
    expect(await locks.acquireLock('memnox:job:lock', 60)).toBe(true);
  });

  it('keeps the legacy outage asymmetry: locks fail closed, cooldowns fail open', async () => {
    const redis = new StubRedis();
    redis.failing = true;
    const locks = new RedisLockService(redis);
    expect(await locks.acquireLock('memnox:job:lock', 60)).toBe(false);
    expect(await locks.checkAndSetCooldown('memnox:notify:cooldown', 60)).toBe(true);
  });

  it('increments atomically via the Lua script with the TTL argument', async () => {
    const redis = new StubRedis();
    const locks = new RedisLockService(redis);
    expect(await locks.increment('memnox:counter', 300)).toBe(1);
    expect(await locks.increment('memnox:counter', 300)).toBe(2);
    expect(redis.evalCalls[0]).toEqual({ key: 'memnox:counter', ttl: '300' });
  });
});

describe('InProcessLockService', () => {
  it('provides the same contract for single-instance deployments', async () => {
    const locks = new InProcessLockService();
    expect(await locks.acquireLock('job', 60)).toBe(true);
    expect(await locks.acquireLock('job', 60)).toBe(false);
    await locks.releaseLock('job');
    expect(await locks.acquireLock('job', 60)).toBe(true);
    expect(await locks.checkAndSetCooldown('cool', 60)).toBe(true);
    expect(await locks.checkAndSetCooldown('cool', 60)).toBe(false);
    expect(await locks.increment('count', 60)).toBe(1);
    expect(await locks.increment('count', 60)).toBe(2);
  });
});
