import { describe, expect, it } from 'vitest';
import {
  DECISION_EFFECT,
  InProcessLockService,
  RISK_LEVEL,
  SILENT_LOGGER,
  type ActionEvent,
} from '@memnox/core';
import {
  AUDIT_RETENTION_LOCK_KEY,
  scheduleAuditRetention,
  sweepAuditRetention,
} from '../src/audit-retention';
import { InMemoryAuditLog } from '../src/stores/in-memory-audit-log';

const DAY_MS = 24 * 60 * 60 * 1_000;
const RETENTION_DAYS = 30;

function agedEvent(id: string, daysAgo: number): ActionEvent {
  return {
    id,
    occurredAt: new Date(Date.now() - daysAgo * DAY_MS).toISOString(),
    agentId: 'a1',
    agentName: 'claude-code',
    action: 'file.read',
    effect: DECISION_EFFECT.ALLOW,
    riskLevel: RISK_LEVEL.LOW,
    matchedPolicies: [],
    advisories: [],
    reason: 'allowed',
  };
}

async function seededLog(): Promise<InMemoryAuditLog> {
  const log = new InMemoryAuditLog();
  await log.append(agedEvent('old-1', 90));
  await log.append(agedEvent('old-2', 60));
  await log.append(agedEvent('fresh', 1));
  return log;
}

describe('audit retention sweep', () => {
  it('prunes past the cutoff and leaves recent events alone', async () => {
    const log = await seededLog();

    const removed = await sweepAuditRetention(
      log,
      new InProcessLockService(),
      RETENTION_DAYS,
      SILENT_LOGGER,
    );

    expect(removed).toBe(2);
    expect((await log.query({})).map((event) => event.id)).toEqual(['fresh']);
  });

  it('does nothing when retention is disabled', async () => {
    const log = await seededLog();
    expect(
      await sweepAuditRetention(log, new InProcessLockService(), 0, SILENT_LOGGER),
    ).toBe(0);
    expect(await log.query({})).toHaveLength(3);
  });

  it('skips the sweep when another pod holds the lock', async () => {
    const log = await seededLog();
    const locks = new InProcessLockService();
    await locks.acquireLock(AUDIT_RETENTION_LOCK_KEY, 60);

    expect(await sweepAuditRetention(log, locks, RETENTION_DAYS, SILENT_LOGGER)).toBe(0);
    expect(await log.query({})).toHaveLength(3);
  });

  it('releases the lock so the next sweep can run', async () => {
    const log = await seededLog();
    const locks = new InProcessLockService();

    await sweepAuditRetention(log, locks, RETENTION_DAYS, SILENT_LOGGER);
    expect(await locks.acquireLock(AUDIT_RETENTION_LOCK_KEY, 60)).toBe(true);
  });

  it('schedules nothing when retention is off and stops cleanly when on', async () => {
    const log = await seededLog();
    const locks = new InProcessLockService();

    scheduleAuditRetention(log, locks, 0, SILENT_LOGGER)();
    scheduleAuditRetention(log, locks, RETENTION_DAYS, SILENT_LOGGER)();
    expect(await log.query({})).toHaveLength(3);
  });
});
