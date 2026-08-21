import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import type { LockService, Logger } from '@memnox/core';
import { SILENT_LOGGER } from '@memnox/core';

const RETRY_BASE_MS = 200;
const RETRY_MAX_MS = 30_000;
const PROBE_KEY_PREFIX = 'memnox:redis:probe';
const PROBE_TTL_S = 10;
/** The client connects asynchronously; a not-yet-open socket is not "unreachable". */
const PROBE_ATTEMPTS = 20;
const PROBE_RETRY_MS = 250;

/** INCR+EXPIRE as two commands leaks a TTL-less key on crash — Lua makes it atomic. */
const INCREMENT_SCRIPT = `local n = redis.call('INCR', KEYS[1])
if n == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
return n`;

/** The subset of ioredis this service uses — injectable for tests. */
export interface RedisLike {
  /** Omit the condition for an unconditional SET with TTL. */
  set(
    key: string,
    value: string,
    expiryMode: 'EX',
    ttl: number,
    condition?: 'NX',
  ): Promise<'OK' | null>;
  get(key: string): Promise<string | null>;
  del(key: string): Promise<number>;
  eval(script: string, numKeys: number, key: string, arg: string): Promise<unknown>;
  quit(): Promise<'OK'>;
  on(event: 'error' | 'ready', listener: (arg?: unknown) => void): unknown;
}

/** One resilient client, shareable by every Redis-backed adapter in a process. */
export function connectRedis(redisUrl: string): RedisLike {
  const client = new Redis(redisUrl, {
    lazyConnect: false,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    // Never return null: that permanently stops reconnection.
    retryStrategy: (times) => Math.min(RETRY_BASE_MS * 2 ** times, RETRY_MAX_MS),
  });
  return client as unknown as RedisLike;
}

/** Every method degrades with its own fallback; state transitions are what get logged. */
export class RedisLockService implements LockService {
  private available = false;

  constructor(
    private readonly client: RedisLike,
    private readonly logger: Logger = SILENT_LOGGER,
  ) {
    client.on('ready', () => {
      if (!this.available) this.logger.info('redis connected — distributed locks active');
      this.available = true;
    });
    client.on('error', (err) => {
      if (this.available) this.logger.error(`redis unavailable: ${String(err)}`);
      this.available = false;
    });
  }

  get isAvailable(): boolean {
    return this.available;
  }

  /** Fail closed: a duplicate cron run is worse than a skipped one. */
  async acquireLock(key: string, ttlSeconds: number): Promise<boolean> {
    try {
      const result = await this.client.set(key, '1', 'EX', ttlSeconds, 'NX');
      return result === 'OK';
    } catch (err) {
      this.logger.warn(`acquireLock(${key}) failed — skipping run: ${String(err)}`);
      return false;
    }
  }

  async releaseLock(key: string): Promise<void> {
    try {
      await this.client.del(key);
    } catch (err) {
      this.logger.warn(`releaseLock(${key}) failed — TTL will expire it: ${String(err)}`);
    }
  }

  /** Fail open: a missed notification is worse than a repeated one. */
  async checkAndSetCooldown(key: string, ttlSeconds: number): Promise<boolean> {
    try {
      const result = await this.client.set(key, '1', 'EX', ttlSeconds, 'NX');
      return result === 'OK';
    } catch (err) {
      this.logger.warn(`cooldown(${key}) unreadable — proceeding: ${String(err)}`);
      return true;
    }
  }

  async increment(key: string, ttlSeconds: number): Promise<number> {
    try {
      const result = await this.client.eval(INCREMENT_SCRIPT, 1, key, String(ttlSeconds));
      return Number(result);
    } catch (err) {
      this.logger.warn(`increment(${key}) failed: ${String(err)}`);
      return 1;
    }
  }

  async close(): Promise<void> {
    try {
      await this.client.quit();
    } catch (err) {
      this.logger.warn(`redis quit failed: ${String(err)}`);
    }
  }
}

/** A configured-but-unreachable Redis must fail loudly, not silently go per-pod. */
export async function assertRedisReachable(
  locks: RedisLockService,
  attempts: number = PROBE_ATTEMPTS,
  delayMs: number = PROBE_RETRY_MS,
): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const probeKey = `${PROBE_KEY_PREFIX}:${randomUUID()}`;
    if (await locks.acquireLock(probeKey, PROBE_TTL_S)) {
      await locks.releaseLock(probeKey);
      return;
    }
    if (attempt < attempts - 1) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  await locks.close();
  // The URL can carry credentials — never echo it.
  throw new Error(
    'Redis is unreachable (--redis-url / MEMNOX_REDIS_URL) — refusing to start',
  );
}
