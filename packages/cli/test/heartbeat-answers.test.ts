import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { HOLD_ANSWER, PendingApprovals, type HoldRequest } from '@memnox/core';

const request: HoldRequest = {
  sessionId: 'ses_1',
  agent: 'hermes',
  operation: 'vercel.deploy-production',
  fingerprint: 'abc12345',
  reason: 'production deploys are held',
  target: 'shop',
};

const home = (): Promise<string> => mkdtemp(join(tmpdir(), 'memnox-beat-'));
const NOW = '2026-09-05T10:00:00.000Z';

/**
 * The seam writes a held call to disk and polls it; the heartbeat is the only
 * per-machine round trip there is. These assert the contract between them — that an
 * answer arriving from anywhere lands where the waiting seam is looking.
 */
describe('an answer from the workspace reaches the machine', () => {
  it('releases the call the seam is waiting on', async () => {
    const where = await home();
    const approvals = new PendingApprovals(where);
    const pending = await approvals.raise(request, NOW, 120_000);

    // What the heartbeat would do with { id, answer } coming back.
    await approvals.answer(pending.id, HOLD_ANSWER.ONCE, 'a reviewer', NOW);

    const answered = await approvals.read(pending.id);
    expect(answered?.answer).toBe(HOLD_ANSWER.ONCE);
    expect(answered?.answeredBy).toBe('a reviewer');
  });

  it('carries a refusal as a refusal', async () => {
    const approvals = new PendingApprovals(await home());
    const pending = await approvals.raise(request, NOW, 120_000);
    await approvals.answer(pending.id, HOLD_ANSWER.DENY, 'a reviewer', NOW);
    expect((await approvals.read(pending.id))?.answer).toBe(HOLD_ANSWER.DENY);
  });

  /* Two people reaching for the same approval is ordinary. The first answer stands,
     so a terminal and the workspace cannot overwrite each other. */
  it('keeps the first answer when two arrive', async () => {
    const approvals = new PendingApprovals(await home());
    const pending = await approvals.raise(request, NOW, 120_000);

    await approvals.answer(pending.id, HOLD_ANSWER.ONCE, 'the terminal', NOW);
    const second = await approvals.answer(
      pending.id,
      HOLD_ANSWER.DENY,
      'the workspace',
      NOW,
    );

    expect(second).not.toBeNull();
    expect(second !== null && 'alreadyAnswered' in second).toBe(true);
    expect((await approvals.read(pending.id))?.answeredBy).toBe('the terminal');
  });

  it('has nothing to say about an id this machine never raised', async () => {
    const approvals = new PendingApprovals(await home());
    expect(await approvals.answer('apr_nothing', HOLD_ANSWER.ONCE, 'x', NOW)).toBeNull();
  });

  /* Names only. What crosses the wire about a held call is the operation and what it
     is about — never the arguments, which is the rule the ledger already follows. */
  it('holds nothing in the record that the wire should not carry', async () => {
    const approvals = new PendingApprovals(await home());
    const pending = await approvals.raise(request, NOW, 120_000);
    const wire = {
      id: pending.id,
      agent: pending.request.agent,
      operation: pending.request.operation,
      target: pending.request.target,
      reason: pending.request.reason,
    };
    expect(Object.keys(wire)).not.toContain('command');
    expect(JSON.stringify(wire)).not.toContain('arguments');
  });
});
