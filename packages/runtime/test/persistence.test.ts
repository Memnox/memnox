import { mkdtemp, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { APPROVAL_STATUS, DEFAULT_MIN_APPROVALS, PLAIN_TEXT_CODEC } from '@memnox/core';
import type { Approval } from '@memnox/core';
import { AesGcmCodec } from '../src/stores/aes-codec';
import { JsonFileApprovalStore } from '../src/stores/json-file-approval-store';
import { JsonFileIdentityStore } from '../src/stores/json-file-identity-store';

const DATA_KEY = ['unit', 'data', 'key'].join('-');

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

describe('AesGcmCodec', () => {
  it('round-trips and reads pre-encryption plaintext unchanged', () => {
    const codec = new AesGcmCodec(DATA_KEY);
    const encoded = codec.encode('hello world');
    expect(encoded).not.toContain('hello');
    expect(codec.decode(encoded)).toBe('hello world');
    expect(codec.decode('legacy plaintext')).toBe('legacy plaintext');
  });

  it('produces different ciphertext each time (random IV)', () => {
    const codec = new AesGcmCodec(DATA_KEY);
    expect(codec.encode('same')).not.toBe(codec.encode('same'));
  });
});

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

  it('encrypts at rest when a codec is supplied', async () => {
    const path = join(dataDir, 'approvals.json');
    const codec = new AesGcmCodec(DATA_KEY);
    await new JsonFileApprovalStore(path, codec).save(approval({}));

    const onDisk = readFileSync(path, 'utf8');
    expect(onDisk).not.toContain('deploy.service');
    const reloaded = new JsonFileApprovalStore(path, codec);
    expect((await reloaded.findById('app-1'))?.action).toBe('deploy.service');
  });
});

describe('JsonFileIdentityStore codec', () => {
  it('reads back what it encrypted', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'memnox-agents-'));
    const path = join(dataDir, 'agents.json');
    const codec = new AesGcmCodec(DATA_KEY);
    const store = new JsonFileIdentityStore(path, codec);
    await store.save({
      id: 'a1',
      name: 'claude-code',
      kind: 'claude-code',
      status: 'active',
      tokenHash: 'hash',
      createdAt: new Date().toISOString(),
      stats: { allowed: 0, withheld: 0, approvalsRequested: 0 },
    });
    expect(readFileSync(path, 'utf8')).not.toContain('claude-code');
    expect((await new JsonFileIdentityStore(path, codec).findById('a1'))?.name).toBe(
      'claude-code',
    );
    expect(PLAIN_TEXT_CODEC.decode(PLAIN_TEXT_CODEC.encode('x'))).toBe('x');
    await rm(dataDir, { recursive: true, force: true });
  });
});
