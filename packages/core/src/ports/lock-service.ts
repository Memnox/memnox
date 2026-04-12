/**
 * Distributed coordination port. The two lookalike methods have deliberately
 * OPPOSITE outage semantics (legacy-proven):
 * - acquireLock fails CLOSED (false when the backend is down — skip the run,
 *   a duplicate cron is worse than a missed one)
 * - checkAndSetCooldown fails OPEN (true when down — a missed notification is
 *   worse than a repeated one)
 */
export interface LockService {
  /** SET NX EX. True = lock acquired, proceed. */
  acquireLock(key: string, ttlSeconds: number): Promise<boolean>;
  releaseLock(key: string): Promise<void>;
  /** True = not on cooldown, proceed (and the cooldown is now set). */
  checkAndSetCooldown(key: string, ttlSeconds: number): Promise<boolean>;
  /** Atomic increment with TTL set only on first increment. */
  increment(key: string, ttlSeconds: number): Promise<number>;
}

/**
 * Single-process implementation — correct semantics without a backend, so
 * every deployment starts with locking and upgrades to Redis when it scales.
 */
export class InProcessLockService implements LockService {
  private readonly entries = new Map<string, { value: number; expiresAt: number }>();

  async acquireLock(key: string, ttlSeconds: number): Promise<boolean> {
    return this.setIfAbsent(key, ttlSeconds);
  }

  async releaseLock(key: string): Promise<void> {
    this.entries.delete(key);
  }

  async checkAndSetCooldown(key: string, ttlSeconds: number): Promise<boolean> {
    return this.setIfAbsent(key, ttlSeconds);
  }

  async increment(key: string, ttlSeconds: number): Promise<number> {
    const existing = this.live(key);
    if (!existing) {
      this.entries.set(key, { value: 1, expiresAt: this.expiry(ttlSeconds) });
      return 1;
    }
    existing.value += 1;
    return existing.value;
  }

  private setIfAbsent(key: string, ttlSeconds: number): boolean {
    if (this.live(key)) return false;
    this.entries.set(key, { value: 1, expiresAt: this.expiry(ttlSeconds) });
    return true;
  }

  private live(key: string): { value: number; expiresAt: number } | null {
    const entry = this.entries.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
      this.entries.delete(key);
      return null;
    }
    return entry;
  }

  private expiry(ttlSeconds: number): number {
    return Date.now() + ttlSeconds * 1_000;
  }
}
