import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readWorkspaceMemory, workspaceMemoryPathFor, type Account } from '@memnox/core';

import { MEMORY_OUTCOME, pullMemory } from '../src/sync/memory';

/**
 * The workspace memory pulled beside the rules: kept whole where a hook reads it, a 304
 * costing nothing, and a failure never losing what this machine already held.
 */

const ACCOUNT: Account = {
  version: 1,
  baseUrl: 'https://cloud.example.test',
  workspaceId: 'acme',
  machineId: 'mch_1',
  token: 'mt_test',
  privateKey: 'unused',
  enrolledAt: '2026-09-01T00:00:00.000Z',
};

const MEMORY = {
  hash: 'm1',
  withheld: 1,
  facts: [
    {
      id: 'f1',
      kind: 'decision',
      statement: 'Retry logic must remain inside PaymentService.',
      subject: 'payments',
      verifiedBy: 'ada@acme.test',
    },
  ],
};

const at = (iso: string) => () => new Date(iso);

function answering(status: number, body?: unknown): string[] {
  const asked: string[] = [];
  vi.stubGlobal('fetch', async (url: URL, init: RequestInit) => {
    const headers = init.headers as Record<string, string>;
    asked.push(`${String(url)} ${headers['if-none-match'] ?? ''}`.trim());
    return new Response(body === undefined ? null : JSON.stringify(body), { status });
  });
  return asked;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('pulling what the workspace settled', () => {
  it('keeps the memory whole, where a hook reads it', async () => {
    const home = await mkdtemp(join(tmpdir(), 'memnox-memory-pull-'));
    const asked = answering(200, MEMORY);

    const pulled = await pullMemory(home, ACCOUNT, at('2026-09-26T08:00:00.000Z'));

    expect(pulled).toEqual({ outcome: MEMORY_OUTCOME.APPLIED, facts: 1 });
    expect(asked).toEqual(['https://cloud.example.test/v1/workspaces/acme/memory']);
    expect(await readWorkspaceMemory(home)).toEqual({
      ...MEMORY,
      syncedAt: '2026-09-26T08:00:00.000Z',
    });
  });

  it('asks with the hash it holds, and a 304 only moves when it last heard', async () => {
    const home = await mkdtemp(join(tmpdir(), 'memnox-memory-pull-'));
    answering(200, MEMORY);
    await pullMemory(home, ACCOUNT, at('2026-09-26T08:00:00.000Z'));
    const kept = await readFile(workspaceMemoryPathFor(home), 'utf8');
    const asked = answering(304);

    const pulled = await pullMemory(home, ACCOUNT, at('2026-09-26T09:00:00.000Z'));

    expect(pulled.outcome).toBe(MEMORY_OUTCOME.UNCHANGED);
    expect(asked[0]).toContain('"m1"');
    expect(await readFile(workspaceMemoryPathFor(home), 'utf8')).toBe(kept);
    expect((await readWorkspaceMemory(home))?.syncedAt).toBe('2026-09-26T09:00:00.000Z');
    expect((await readWorkspaceMemory(home))?.facts).toHaveLength(1);
  });

  it('keeps what it held when the control plane refuses or cannot be reached', async () => {
    const home = await mkdtemp(join(tmpdir(), 'memnox-memory-pull-'));
    answering(200, MEMORY);
    await pullMemory(home, ACCOUNT, at('2026-09-26T08:00:00.000Z'));

    answering(500, { error: 'down' });
    expect((await pullMemory(home, ACCOUNT)).outcome).toBe(MEMORY_OUTCOME.KEPT);
    vi.stubGlobal('fetch', async () => {
      throw new Error('offline');
    });
    expect((await pullMemory(home, ACCOUNT)).outcome).toBe(MEMORY_OUTCOME.KEPT);

    expect((await readWorkspaceMemory(home))?.facts).toHaveLength(1);
  });
});
