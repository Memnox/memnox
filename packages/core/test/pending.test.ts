import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { HOLD_ANSWER, type HoldRequest } from '../src/gate/hold';
import { PendingApprovals, describePending, waitForAnswer } from '../src/gate/pending';

const NOW = '2026-09-05T10:00:00.000Z';
const REQUEST: HoldRequest = {
  sessionId: 'ses_1',
  agent: 'claude-code',
  operation: 'vercel.deploy-prod',
  target: 'payments-web',
  fingerprint: 'abc123def456',
  reason: 'production deploys need a person',
};

const home = (): Promise<string> => mkdtemp(join(tmpdir(), 'memnox-pending-'));

describe('a hold something else can answer', () => {
  it('writes it down, so another terminal can see it', async () => {
    const approvals = new PendingApprovals(await home());
    const raised = await approvals.raise(REQUEST, NOW, 120_000);

    const waiting = await approvals.list(NOW);
    expect(waiting.map((each) => each.id)).toEqual([raised.id]);
    expect(describePending(raised, NOW)).toContain('wants to vercel.deploy-prod');
  });

  it('records who answered, because that is the first postmortem question', async () => {
    const approvals = new PendingApprovals(await home());
    const raised = await approvals.raise(REQUEST, NOW, 120_000);

    const outcome = await approvals.answer(raised.id, HOLD_ANSWER.ONCE, 'tresor', NOW);
    expect(outcome).not.toBeNull();
    expect((outcome as { answered: { answeredBy?: string } }).answered.answeredBy).toBe(
      'tresor',
    );
  });

  it('lets the first answer win, and tells the second what already happened', async () => {
    const approvals = new PendingApprovals(await home());
    const raised = await approvals.raise(REQUEST, NOW, 120_000);

    await approvals.answer(raised.id, HOLD_ANSWER.ONCE, 'first', NOW);
    const second = await approvals.answer(raised.id, HOLD_ANSWER.DENY, 'second', NOW);

    // Two people reaching for the same approval is ordinary, not a failure.
    expect(second).toHaveProperty('alreadyAnswered');
    const already = (second as { alreadyAnswered: { answeredBy?: string } })
      .alreadyAnswered;
    expect(already.answeredBy).toBe('first');
  });

  it('is null for something nobody raised', async () => {
    const approvals = new PendingApprovals(await home());
    expect(await approvals.answer('apr_nope', HOLD_ANSWER.ONCE, 'x', NOW)).toBeNull();
  });

  it('hides an expired hold, so nobody answers one the agent stopped waiting for', async () => {
    const approvals = new PendingApprovals(await home());
    await approvals.raise(REQUEST, NOW, 60_000);

    expect(await approvals.list(NOW)).toHaveLength(1);
    expect(await approvals.list('2026-09-05T10:02:00.000Z')).toHaveLength(0);
  });
});

describe('waiting for somebody to answer', () => {
  it('returns the answer as soon as it appears', async () => {
    const approvals = new PendingApprovals(await home());
    const raised = await approvals.raise(REQUEST, NOW, 120_000);

    let ticks = 0;
    const answer = await waitForAnswer(
      approvals,
      raised.id,
      Date.now() + 5000,
      () => Date.now(),
      async () => {
        ticks += 1;
        if (ticks === 2) {
          await approvals.answer(raised.id, HOLD_ANSWER.SESSION, 'tresor', NOW);
        }
      },
      0,
    );
    expect(answer).toBe(HOLD_ANSWER.SESSION);
  });

  it('gives up at the deadline rather than holding the agent for ever', async () => {
    const approvals = new PendingApprovals(await home());
    const raised = await approvals.raise(REQUEST, NOW, 120_000);

    let clock = 0;
    const answer = await waitForAnswer(
      approvals,
      raised.id,
      100,
      () => (clock += 60),
      async () => undefined,
      0,
    );
    expect(answer).toBeNull();
  });

  it('stops waiting when the hold is cleared out from under it', async () => {
    const approvals = new PendingApprovals(await home());
    const raised = await approvals.raise(REQUEST, NOW, 120_000);
    await approvals.clear(raised.id);

    expect(
      await waitForAnswer(
        approvals,
        raised.id,
        Date.now() + 1000,
        () => Date.now(),
        async () => undefined,
        0,
      ),
    ).toBeNull();
  });
});
