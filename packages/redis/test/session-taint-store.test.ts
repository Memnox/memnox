import { describe, expect, it } from 'vitest';
import {
  CLEAN_TAINT,
  InMemorySessionTaintStore,
  InProcessLockService,
  TAINT_MAX_SOURCE_REFS,
  TAINT_SESSION_TTL_S,
  type SessionTaintStore,
  type TaintAssessment,
} from '@memnox/core';
import { type RedisLike } from '../src/redis-lock.service';
import { RedisSessionTaintStore } from '../src/redis-session-taint-store';

const SESSION = 'sess-1';

const EMAIL_TAINT: TaintAssessment = {
  tainted: true,
  sources: [{ sourceType: 'email_message', reason: 'third-party email in context' }],
};

const SLACK_TAINT: TaintAssessment = {
  tainted: true,
  sources: [{ sourceType: 'slack_message', reason: 'external Slack author' }],
};

/** Records the exact SET arguments so the TTL is assertable without a live Redis. */
class FakeRedis implements RedisLike {
  readonly keys = new Map<string, string>();
  readonly sets: Array<{ key: string; ttl: number; condition?: string }> = [];
  failing = false;

  async set(
    key: string,
    value: string,
    _mode: 'EX',
    ttl: number,
    condition?: 'NX',
  ): Promise<'OK' | null> {
    if (this.failing) throw new Error('connection refused');
    if (condition === 'NX' && this.keys.has(key)) return null;
    this.keys.set(key, value);
    this.sets.push({ key, ttl, ...(condition ? { condition } : {}) });
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

  async eval(): Promise<unknown> {
    return 1;
  }

  async quit(): Promise<'OK'> {
    return 'OK';
  }

  on(): unknown {
    return this;
  }
}

function redisStore(redis: FakeRedis): SessionTaintStore {
  return new RedisSessionTaintStore(redis, new InProcessLockService());
}

const IMPLEMENTATIONS: Array<[string, () => SessionTaintStore]> = [
  ['InMemorySessionTaintStore', (): SessionTaintStore => new InMemorySessionTaintStore()],
  ['RedisSessionTaintStore', (): SessionTaintStore => redisStore(new FakeRedis())],
];

describe.each(IMPLEMENTATIONS)('%s — SessionTaintStore contract', (_name, create) => {
  it('reports an unseen session as clean and available', async () => {
    const state = await create().read(SESSION);
    expect(state.taint.tainted).toBe(false);
    expect(state.available).toBe(true);
  });

  it('merges taint in and keeps it for later reads', async () => {
    const store = create();
    await store.merge(SESSION, EMAIL_TAINT);
    const state = await store.read(SESSION);
    expect(state.taint.tainted).toBe(true);
    expect(state.taint.sources.map((source) => source.sourceType)).toEqual([
      'email_message',
    ]);
  });

  it('is monotonic: a clean assessment never clears an existing taint', async () => {
    const store = create();
    await store.merge(SESSION, EMAIL_TAINT);
    await store.merge(SESSION, CLEAN_TAINT);
    expect((await store.read(SESSION)).taint.tainted).toBe(true);
  });

  it('accumulates distinct sources and keeps sessions isolated', async () => {
    const store = create();
    await store.merge(SESSION, EMAIL_TAINT);
    await store.merge(SESSION, SLACK_TAINT);
    expect((await store.read(SESSION)).taint.sources).toHaveLength(2);
    expect((await store.read('sess-2')).taint.tainted).toBe(false);
  });

  it('caps the stored source refs', async () => {
    const store = create();
    for (let index = 0; index < TAINT_MAX_SOURCE_REFS * 2; index += 1) {
      await store.merge(SESSION, {
        tainted: true,
        sources: [
          {
            sourceType: 'email_message',
            reference: `msg-${index}`,
            reason: 'third-party email',
          },
        ],
      });
    }
    expect((await store.read(SESSION)).taint.sources).toHaveLength(TAINT_MAX_SOURCE_REFS);
  });
});

describe('RedisSessionTaintStore', () => {
  it('writes with the session TTL so provenance expires with the session', async () => {
    const redis = new FakeRedis();
    await redisStore(redis).merge(SESSION, EMAIL_TAINT);
    const write = redis.sets.find((entry) => entry.key.includes(SESSION));
    expect(write?.ttl).toBe(TAINT_SESSION_TTL_S);
    expect(write?.condition).toBeUndefined();
  });

  it('treats corrupt state as tainted rather than clean', async () => {
    const redis = new FakeRedis();
    const store = redisStore(redis);
    await store.merge(SESSION, EMAIL_TAINT);
    const key = [...redis.keys.keys()].find((entry) => entry.includes(SESSION)) ?? '';
    redis.keys.set(key, '{"tainted":true,"sources":');

    const state = await store.read(SESSION);
    expect(state.taint.tainted).toBe(true);
    expect(state.available).toBe(true);
  });

  it('fails closed when the backend is unreachable', async () => {
    const redis = new FakeRedis();
    redis.failing = true;
    const state = await redisStore(redis).read(SESSION);
    expect(state.taint.tainted).toBe(true);
    expect(state.available).toBe(false);
  });

  it('never throws out of merge when the backend is down', async () => {
    const redis = new FakeRedis();
    redis.failing = true;
    await expect(redisStore(redis).merge(SESSION, EMAIL_TAINT)).resolves.toBeUndefined();
  });
});
