import { describe, expect, it } from 'vitest';
import {
  APPROVAL_STATUS,
  DECISION_EFFECT,
  DEFAULT_MIN_APPROVALS,
  InProcessLockService,
  RISK_LEVEL,
  SILENT_LOGGER,
  type ActionEvent,
  type Approval,
  type ApprovalStatus,
} from '@memnox/core';
import {
  APPROVAL_RETENTION_LOCK_KEY,
  AUDIT_RETENTION_LOCK_KEY,
  scheduleAuditRetention,
  sweepApprovalRetention,
  sweepAuditRetention,
} from '../src/audit-retention';
import { InMemoryApprovalStore } from '../src/stores/in-memory-approval-store';
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

    const approvals = new InMemoryApprovalStore();
    scheduleAuditRetention(log, approvals, locks, 0, SILENT_LOGGER)();
    scheduleAuditRetention(log, approvals, locks, RETENTION_DAYS, SILENT_LOGGER)();
    expect(await log.query({})).toHaveLength(3);
  });
});

function agedApproval(id: string, daysAgo: number, status: ApprovalStatus): Approval {
  return {
    id,
    requestFingerprint: `fp-${id}`,
    agentId: 'a1',
    action: 'deploy.service',
    approvers: ['eng-lead'],
    minApprovals: DEFAULT_MIN_APPROVALS,
    grants: [],
    status,
    createdAt: new Date(Date.now() - daysAgo * DAY_MS).toISOString(),
  };
}

async function seededApprovals(): Promise<InMemoryApprovalStore> {
  const store = new InMemoryApprovalStore();
  await store.save(agedApproval('old-approved', 90, APPROVAL_STATUS.APPROVED));
  await store.save(agedApproval('old-denied', 60, APPROVAL_STATUS.DENIED));
  await store.save(agedApproval('old-expired', 60, APPROVAL_STATUS.EXPIRED));
  await store.save(agedApproval('old-pending', 90, APPROVAL_STATUS.PENDING));
  await store.save(agedApproval('fresh-approved', 1, APPROVAL_STATUS.APPROVED));
  return store;
}

describe('approval retention sweep', () => {
  const remaining = async (store: InMemoryApprovalStore): Promise<string[]> => {
    const all = await Promise.all(
      Object.values(APPROVAL_STATUS).map((status) => store.listByStatus(status)),
    );
    return all.flat().map((approval) => approval.id);
  };

  it('prunes resolved approvals past the cutoff', async () => {
    const store = await seededApprovals();

    const removed = await sweepApprovalRetention(
      store,
      new InProcessLockService(),
      RETENTION_DAYS,
      SILENT_LOGGER,
    );

    expect(removed).toBe(3);
    expect(await remaining(store)).toEqual(
      expect.arrayContaining(['old-pending', 'fresh-approved']),
    );
    expect(await remaining(store)).toHaveLength(2);
  });

  // A hold nobody answered is a decision still owed, however old it looks.
  it('never prunes a pending approval', async () => {
    const store = await seededApprovals();
    await sweepApprovalRetention(
      store,
      new InProcessLockService(),
      RETENTION_DAYS,
      SILENT_LOGGER,
    );

    expect(await store.findById('old-pending')).not.toBeNull();
  });

  it('does nothing when retention is disabled', async () => {
    const store = await seededApprovals();
    expect(
      await sweepApprovalRetention(store, new InProcessLockService(), 0, SILENT_LOGGER),
    ).toBe(0);
    expect(await remaining(store)).toHaveLength(5);
  });

  it('skips the sweep when another pod holds the lock', async () => {
    const store = await seededApprovals();
    const locks = new InProcessLockService();
    await locks.acquireLock(APPROVAL_RETENTION_LOCK_KEY, 60);

    expect(
      await sweepApprovalRetention(store, locks, RETENTION_DAYS, SILENT_LOGGER),
    ).toBe(0);
    expect(await remaining(store)).toHaveLength(5);
  });

  // Its own key, so a slow audit sweep never starves the approval sweep.
  it('releases its own lock and does not take the audit one', async () => {
    const store = await seededApprovals();
    const locks = new InProcessLockService();

    await sweepApprovalRetention(store, locks, RETENTION_DAYS, SILENT_LOGGER);
    expect(await locks.acquireLock(APPROVAL_RETENTION_LOCK_KEY, 60)).toBe(true);
    expect(await locks.acquireLock(AUDIT_RETENTION_LOCK_KEY, 60)).toBe(true);
  });
});
