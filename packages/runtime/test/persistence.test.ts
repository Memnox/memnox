import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { APPROVAL_STATUS, DEFAULT_MIN_APPROVALS } from '@memnox/core';
import type { Approval } from '@memnox/core';
import { JsonFileApprovalStore } from '../src/stores/json-file-approval-store';

function approval(overrides: Partial<Approval>): Approval {
  return {
    id: 'app-1',
    requestFingerprint: 'fp-1',
    agentId: 'agent-1',
    action: 'deploy.service',
    approvers: ['eng-lead'],
    minApprovals: DEFAULT_MIN_APPROVALS,
    grants: [],
    status: APPROVAL_STATUS.PENDING,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('JsonFileApprovalStore', () => {
  let dataDir: string;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'memnox-approvals-'));
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  it('survives a restart — a new store instance sees the pending approval', async () => {
    const path = join(dataDir, 'approvals.json');
    await new JsonFileApprovalStore(path).save(approval({}));

    const reloaded = new JsonFileApprovalStore(path);
    expect((await reloaded.findById('app-1'))?.status).toBe(APPROVAL_STATUS.PENDING);
    expect(await reloaded.findPendingByFingerprint('fp-1')).not.toBeNull();
  });

  // Storage, not TTL policy: ApprovalService filters, and flowSummary has to see
  // a lapsed record to report it. Filtering here made this store disagree with Postgres.
  it('returns expired pending approvals like every other adapter', async () => {
    const store = new JsonFileApprovalStore(join(dataDir, 'approvals.json'));
    await store.save(approval({ expiresAt: '2020-01-01T00:00:00.000Z' }));
    expect(await store.findPendingByFingerprint('fp-1')).not.toBeNull();
    expect(await store.listByStatus(APPROVAL_STATUS.PENDING)).toHaveLength(1);
  });

  it('prunes resolved approvals and persists the smaller file', async () => {
    const path = join(dataDir, 'approvals.json');
    const store = new JsonFileApprovalStore(path);
    await store.save(approval({ createdAt: '2026-01-01T00:00:00.000Z' }));
    await store.save(
      approval({
        id: 'app-2',
        createdAt: '2026-01-01T00:00:00.000Z',
        status: APPROVAL_STATUS.APPROVED,
      }),
    );

    expect(await store.pruneResolvedBefore('2026-06-01T00:00:00.000Z')).toBe(1);
    // A pending hold is a decision still owed, so age alone never removes it.
    expect(await new JsonFileApprovalStore(path).findById('app-1')).not.toBeNull();
    expect(await new JsonFileApprovalStore(path).findById('app-2')).toBeNull();
  });
});
