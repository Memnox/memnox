import type { LockService } from './lock-service';

export const RATE_LIMIT_KEY_PREFIX = 'memnox:ratelimit';

/**
 * Fixed-window limiter over the LockService counter (Lua-atomic with TTL).
 * Inherits the backend's failure semantics: when the counter is unreadable,
 * increment() returns 1 — the limiter fails open, availability over strictness.
 */
export class FixedWindowRateLimiter {
  constructor(private readonly locks: LockService) {}

  /** True = under the limit, proceed. Window starts at the first hit. */
  async allow(key: string, limit: number, windowSeconds: number): Promise<boolean> {
    if (limit <= 0) return true; // 0 = disabled
    const count = await this.locks.increment(
      `${RATE_LIMIT_KEY_PREFIX}:${key}`,
      windowSeconds,
    );
    return count <= limit;
  }
}
