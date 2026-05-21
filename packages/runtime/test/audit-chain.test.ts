import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AUDIT_CHAIN_BREAK,
  DECISION_EFFECT,
  GENESIS_HASH,
  RISK_LEVEL,
  type ActionEvent,
} from '@memnox/core';
import { InMemoryAuditLog } from '../src/stores/in-memory-audit-log';
import { JsonlAuditLog } from '../src/stores/jsonl-audit-log';

function auditEvent(
  id: string,
  occurredAt: string,
  overrides: Partial<ActionEvent> = {},
): ActionEvent {
  return {
    id,
    occurredAt,
    agentId: 'a1',
    agentName: 'claude-code',
    action: 'file.read',
    effect: DECISION_EFFECT.ALLOW,
    riskLevel: RISK_LEVEL.LOW,
    matchedPolicies: [],
    advisories: [],
    reason: 'allowed',
    ...overrides,
  };
}

const DAY = (day: number): string =>
  `2026-07-${String(day).padStart(2, '0')}T00:00:00.000Z`;

describe('JsonlAuditLog hash chain', () => {
  let dataDir: string;
  let filePath: string;
  let log: JsonlAuditLog;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'memnox-chain-'));
    filePath = join(dataDir, 'audit.jsonl');
    log = new JsonlAuditLog(filePath);
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  it('anchors the first event on the genesis hash and links the rest', async () => {
    for (let day = 1; day <= 3; day += 1)
      await log.append(auditEvent(`e${day}`, DAY(day)));

    const events = await log.query({});
    expect(events[0]?.prevHash).toBe(GENESIS_HASH);
    expect(events[1]?.prevHash).toBe(events[0]?.hash);
    expect(events[2]?.prevHash).toBe(events[1]?.hash);
    expect(await log.verifyChain()).toEqual({
      valid: true,
      checked: 3,
      brokenAtIndex: -1,
    });
  });

  it('reports the index of an edited record', async () => {
    for (let day = 1; day <= 4; day += 1)
      await log.append(auditEvent(`e${day}`, DAY(day)));
    const lines = (await readFile(filePath, 'utf8')).trim().split('\n');
    const forged = JSON.parse(lines[2] as string) as ActionEvent;
    forged.reason = 'quietly rewritten';
    lines[2] = JSON.stringify(forged);
    await writeFile(filePath, `${lines.join('\n')}\n`, 'utf8');

    const result = await log.verifyChain();
    expect(result.valid).toBe(false);
    expect(result.brokenAtIndex).toBe(2);
    expect(result.brokenEventId).toBe('e3');
    expect(result.brokenReason).toBe(AUDIT_CHAIN_BREAK.CONTENT_MISMATCH);
  });

  it('reports a removed record as a broken link', async () => {
    for (let day = 1; day <= 4; day += 1)
      await log.append(auditEvent(`e${day}`, DAY(day)));
    const lines = (await readFile(filePath, 'utf8')).trim().split('\n');
    lines.splice(1, 1);
    await writeFile(filePath, `${lines.join('\n')}\n`, 'utf8');

    const result = await log.verifyChain();
    expect(result.brokenAtIndex).toBe(1);
    expect(result.brokenReason).toBe(AUDIT_CHAIN_BREAK.PREV_MISMATCH);
  });

  it('reads only the tail for a bounded query and keeps it chronological', async () => {
    for (let day = 1; day <= 9; day += 1)
      await log.append(auditEvent(`e${day}`, DAY(day)));

    expect((await log.query({ limit: 3 })).map((event) => event.id)).toEqual([
      'e7',
      'e8',
      'e9',
    ]);
    expect((await log.recent(2)).map((event) => event.id)).toEqual(['e9', 'e8']);
    expect(
      (await log.query({ sessionId: 'missing', limit: 3 })).map((event) => event.id),
    ).toEqual([]);
  });

  it('prunes old events, keeps the recent ones, and still verifies', async () => {
    for (let day = 1; day <= 5; day += 1)
      await log.append(auditEvent(`e${day}`, DAY(day)));

    expect(await log.pruneBefore(DAY(3))).toBe(2);
    expect((await log.query({})).map((event) => event.id)).toEqual(['e3', 'e4', 'e5']);
    expect((await log.verifyChain()).valid).toBe(true);
    expect(await log.pruneBefore(DAY(3))).toBe(0);
  });

  it('walks back across chunk boundaries without losing a line', async () => {
    // Padding pushes the log well past one backward-read chunk.
    const padding = 'x'.repeat(2_000);
    for (let index = 0; index < 60; index += 1) {
      await log.append(
        auditEvent(
          `e${index}`,
          `2026-07-01T00:00:${String(index).padStart(2, '0')}.000Z`,
          {
            reason: padding,
          },
        ),
      );
    }

    expect((await log.query({ limit: 3 })).map((event) => event.id)).toEqual([
      'e57',
      'e58',
      'e59',
    ]);
    expect((await log.verifyChain()).valid).toBe(true);
  });

  it('filters by orgId and leaves single-tenant events unclaimed', async () => {
    await log.append(auditEvent('e1', DAY(1), { orgId: 'acme' }));
    await log.append(auditEvent('e2', DAY(2), { orgId: 'globex' }));
    await log.append(auditEvent('e3', DAY(3)));

    expect((await log.query({ orgId: 'acme' })).map((event) => event.id)).toEqual(['e1']);
    expect((await log.query({ orgId: 'acme', limit: 5 })).map((e) => e.id)).toEqual([
      'e1',
    ]);
    expect(await log.query({})).toHaveLength(3);
  });
});

describe('InMemoryAuditLog', () => {
  it('chains, bounds, prunes, and verifies like the file-backed log', async () => {
    const log = new InMemoryAuditLog();
    for (let day = 1; day <= 4; day += 1)
      await log.append(auditEvent(`e${day}`, DAY(day)));

    expect((await log.query({ limit: 2 })).map((event) => event.id)).toEqual([
      'e3',
      'e4',
    ]);
    expect((await log.verifyChain()).valid).toBe(true);
    expect(await log.pruneBefore(DAY(3))).toBe(2);
    expect((await log.query({})).map((event) => event.id)).toEqual(['e3', 'e4']);
  });
});
