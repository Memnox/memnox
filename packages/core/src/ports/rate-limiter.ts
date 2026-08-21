import type { LockService } from './lock-service';

export const RATE_LIMIT_KEY_PREFIX = 'memnox:ratelimit';

/** Fixed-window over the LockService counter; fails open when the counter is unreadable. */
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
