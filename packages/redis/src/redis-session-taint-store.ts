import type {
  LockService,
  Logger,
  SessionTaintState,
  SessionTaintStore,
  TaintAssessment,
} from '@memnox/core';
import {
  CLEAN_SESSION_TAINT,
  mergeTaint,
  parseTaintAssessment,
  SILENT_LOGGER,
  TAINT_SESSION_KEY_PREFIX,
  TAINT_SESSION_LOCK_PREFIX,
  TAINT_SESSION_LOCK_TTL_S,
  TAINT_SESSION_TTL_S,
  UNAVAILABLE_SESSION_TAINT,
  UNREADABLE_TAINT,
} from '@memnox/core';
import type { RedisLike } from './redis-lock.service';

/** Unreachable or corrupt state reports taint — unprovable provenance is the attack. */
export class RedisSessionTaintStore implements SessionTaintStore {
  constructor(
    private readonly client: RedisLike,
    private readonly locks: LockService,
    private readonly logger: Logger = SILENT_LOGGER,
  ) {}

  async read(sessionId: string): Promise<SessionTaintState> {
    let raw: string | null;
    try {
      raw = await this.client.get(this.key(sessionId));
    } catch (err) {
      this.logger.error(
        `session taint state unreadable for ${sessionId} — failing closed: ${String(err)}`,
      );
      return UNAVAILABLE_SESSION_TAINT;
    }
    if (raw === null) return CLEAN_SESSION_TAINT;
    const parsed = parseTaintAssessment(raw);
    if (!parsed) {
      this.logger.error(
        `corrupt session taint state for ${sessionId} — treating the session as tainted`,
      );
      return { taint: UNREADABLE_TAINT, available: true };
    }
    return { taint: parsed, available: true };
  }

  async merge(sessionId: string, taint: TaintAssessment): Promise<void> {
    if (!taint.tainted) return;
    const lockKey = `${TAINT_SESSION_LOCK_PREFIX}${sessionId}`;
    // Best-effort lock: losing a source ref is fine, losing the tainted bit is not.
    const locked = await this.locks.acquireLock(lockKey, TAINT_SESSION_LOCK_TTL_S);
    try {
      const current = await this.read(sessionId);
      const merged = mergeTaint(current.taint, taint);
      await this.client.set(
        this.key(sessionId),
        JSON.stringify(merged),
        'EX',
        TAINT_SESSION_TTL_S,
      );
    } catch (err) {
      this.logger.error(
        `session taint merge failed for ${sessionId} — the next read fails closed: ${String(err)}`,
      );
    } finally {
      if (locked) await this.locks.releaseLock(lockKey);
    }
  }

  private key(sessionId: string): string {
    return `${TAINT_SESSION_KEY_PREFIX}${sessionId}`;
  }
}
