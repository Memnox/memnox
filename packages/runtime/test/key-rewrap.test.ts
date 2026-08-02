import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DECISION_EFFECT, RISK_LEVEL, type ActionEvent } from '@memnox/core';
import { AesGcmCodec } from '../src/stores/aes-codec';
import { ENCRYPTION_MODE, KeyringCodec } from '../src/stores/keyring-codec';
import { JsonlAuditLog } from '../src/stores/jsonl-audit-log';
import { keyUsageForDataDir, recodeValue, rewrapDataDir } from '../src/key-rewrap';

// Assembled at runtime so no credential-shaped literal exists in this file.
const LEGACY_SECRET = ['legacy', 'passphrase'].join('-');
const NEW_SECRET = ['rotated', 'passphrase'].join('-');
const NEW_SALT = ['rotated', 'salt'].join('-');

const AUDIT_FILE = 'audit.jsonl';

/** The keyring a mid-rotation deployment holds: old key for reads, new for writes. */
const ROTATING = {
  activeKeyId: 'k2',
  keys: [
    { id: 'v1', secret: LEGACY_SECRET },
    { id: 'k2', secret: NEW_SECRET, salt: NEW_SALT },
  ],
};

let dataDir: string;

function auditEvent(id: string, occurredAt: string): ActionEvent {
  return {
    id,
    occurredAt,
    agentId: 'agt_1',
    agentName: 'claude-code',
    action: 'database.delete',
    effect: DECISION_EFFECT.BLOCK,
    riskLevel: RISK_LEVEL.CRITICAL,
    reason: 'No AI database deletion',
    matchedPolicies: ['production-database-protection'],
  } as ActionEvent;
}

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'memnox-rewrap-'));
});

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

describe('key rewrap', () => {
  it('moves legacy records onto the active key and leaves the plaintext identical', async () => {
    const legacy = new JsonlAuditLog(
      join(dataDir, AUDIT_FILE),
      new AesGcmCodec(LEGACY_SECRET),
    );
    await legacy.append(auditEvent('evt_1', '2026-07-01T00:00:00.000Z'));
    await legacy.append(auditEvent('evt_2', '2026-07-02T00:00:00.000Z'));
    const before = await legacy.query({});

    const codec = new KeyringCodec(ROTATING, ENCRYPTION_MODE.PERMISSIVE);
    const results = await rewrapDataDir(dataDir, codec);

    const audit = results.find((result) => result.source === AUDIT_FILE);
    expect(audit).toBeDefined();
    expect(audit === undefined ? 0 : audit.rewrapped).toBe(2);

    const rotated = new JsonlAuditLog(join(dataDir, AUDIT_FILE), codec);
    expect(await rotated.query({})).toEqual(before);
  });

  it('keeps the audit chain verifiable across a rotation', async () => {
    const legacy = new JsonlAuditLog(
      join(dataDir, AUDIT_FILE),
      new AesGcmCodec(LEGACY_SECRET),
    );
    await legacy.append(auditEvent('evt_1', '2026-07-01T00:00:00.000Z'));
    await legacy.append(auditEvent('evt_2', '2026-07-02T00:00:00.000Z'));
    await legacy.append(auditEvent('evt_3', '2026-07-03T00:00:00.000Z'));

    const codec = new KeyringCodec(ROTATING, ENCRYPTION_MODE.PERMISSIVE);
    await rewrapDataDir(dataDir, codec);

    // The chain hashes decoded content, so re-encoding must not disturb it.
    const rotated = new JsonlAuditLog(join(dataDir, AUDIT_FILE), codec);
    expect(await rotated.verifyChain()).toMatchObject({ valid: true, checked: 3 });
  });

  it('reports every record under the new key once rewrapped', async () => {
    const legacy = new JsonlAuditLog(
      join(dataDir, AUDIT_FILE),
      new AesGcmCodec(LEGACY_SECRET),
    );
    await legacy.append(auditEvent('evt_1', '2026-07-01T00:00:00.000Z'));

    const codec = new KeyringCodec(ROTATING, ENCRYPTION_MODE.PERMISSIVE);
    const before = await keyUsageForDataDir(dataDir, codec);
    await rewrapDataDir(dataDir, codec);
    const after = await keyUsageForDataDir(dataDir, codec);

    expect(before.find((row) => row.source === AUDIT_FILE)).toMatchObject({
      byKeyId: { v1: 1 },
    });
    expect(after.find((row) => row.source === AUDIT_FILE)).toMatchObject({
      byKeyId: { k2: 1 },
    });
  });

  it('is a no-op the second time, so an interrupted run can simply be re-run', async () => {
    const legacy = new JsonlAuditLog(
      join(dataDir, AUDIT_FILE),
      new AesGcmCodec(LEGACY_SECRET),
    );
    await legacy.append(auditEvent('evt_1', '2026-07-01T00:00:00.000Z'));

    const codec = new KeyringCodec(ROTATING, ENCRYPTION_MODE.PERMISSIVE);
    await rewrapDataDir(dataDir, codec);
    const second = await rewrapDataDir(dataDir, codec);

    expect(second.every((result) => result.rewrapped === 0)).toBe(true);
  });

  it('leaves no plaintext on disk after a rewrap', async () => {
    const legacy = new JsonlAuditLog(
      join(dataDir, AUDIT_FILE),
      new AesGcmCodec(LEGACY_SECRET),
    );
    await legacy.append(auditEvent('evt_1', '2026-07-01T00:00:00.000Z'));

    await rewrapDataDir(dataDir, new KeyringCodec(ROTATING, ENCRYPTION_MODE.PERMISSIVE));

    const raw = await readFile(join(dataDir, AUDIT_FILE), 'utf8');
    expect(raw).not.toContain('database.delete');
    expect(raw.startsWith('enc:k2:')).toBe(true);
  });

  it('skips a value already on the active key rather than re-encrypting it', () => {
    const codec = new KeyringCodec(ROTATING, ENCRYPTION_MODE.PERMISSIVE);

    expect(recodeValue(codec, codec.encode('current'))).toBeNull();
    expect(recodeValue(codec, codec.encodeWith('stale', 'v1'))).not.toBeNull();
  });
});
