import type { AuditLog, LockService, Logger } from '@memnox/core';

/** One sweeper across all pods — the lock is what stops N pods pruning in parallel. */
export const AUDIT_RETENTION_LOCK_KEY = 'memnox:audit-retention';
const AUDIT_RETENTION_LOCK_TTL_S = 10 * 60;
export const AUDIT_RETENTION_INTERVAL_MS = 60 * 60 * 1_000;
const MS_PER_DAY = 24 * 60 * 60 * 1_000;

/** Returns how many events were pruned; 0 when disabled, locked out, or already clean. */
export async function sweepAuditRetention(
  auditLog: AuditLog,
  locks: LockService,
  retentionDays: number,
  logger: Logger,
): Promise<number> {
  if (retentionDays <= 0) return 0;
  if (!(await locks.acquireLock(AUDIT_RETENTION_LOCK_KEY, AUDIT_RETENTION_LOCK_TTL_S))) {
    return 0;
  }
  try {
    const cutoff = new Date(Date.now() - retentionDays * MS_PER_DAY).toISOString();
    const removed = await auditLog.pruneBefore(cutoff);
    if (removed > 0)
      logger.info(`audit retention: pruned ${removed} events before ${cutoff}`);
    return removed;
  } catch (err) {
    logger.error(`audit retention sweep failed: ${String(err)}`);
    return 0;
  } finally {
    await locks.releaseLock(AUDIT_RETENTION_LOCK_KEY);
  }
}

/** Starts the periodic sweep; returns the stop function. No-op when retention is off. */
export function scheduleAuditRetention(
  auditLog: AuditLog,
  locks: LockService,
  retentionDays: number,
  logger: Logger,
): () => void {
  if (retentionDays <= 0) return () => undefined;
  const timer = setInterval(() => {
    void sweepAuditRetention(auditLog, locks, retentionDays, logger);
  }, AUDIT_RETENTION_INTERVAL_MS);
  // Retention must never be the reason a process refuses to exit.
  timer.unref();
  return () => clearInterval(timer);
}
