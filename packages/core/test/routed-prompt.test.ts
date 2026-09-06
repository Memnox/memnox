import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RoutedHoldPrompt } from '../src/gate/routed-prompt';
import { PendingApprovals } from '../src/gate/pending';
import {
  HOLD_ANSWER,
  HOLD_OUTCOME,
  HoldService,
  type HoldAsked,
  type HoldPrompt,
  type HoldRequest,
} from '../src/gate/hold';

const request: HoldRequest = {
  sessionId: 'ses_1',
  agent: 'claude-code',
  operation: 'vercel.deploy-production',
  fingerprint: 'abc12345',
  reason: 'production deploys are held',
};

const home = (): Promise<string> => mkdtemp(join(tmpdir(), 'memnox-routed-'));

/**
 * Real time, in small amounts.
 *
 * A virtual clock cannot be used here: the waiter polls a file that another party
 * writes, so advancing time instantly burns the whole deadline before the answer can
 * land. The intervals are milliseconds, so this stays fast without pretending.
 */
const POLL_MS = 10;
const PATIENT_MS = 2_000;
const IMPATIENT_MS = 150;

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 30));

const silent: HoldPrompt = { ask: async () => null };

describe('a held call is written down before anybody is asked', () => {
  it('raises it where another terminal can find it', async () => {
    const where = await home();
    const approvals = new PendingApprovals(where);
    const said: string[] = [];

    const prompt = new RoutedHoldPrompt({
      approvals,
      announce: (message) => said.push(message),
      pollMs: POLL_MS,
    });

    const asking = prompt.ask(request, PATIENT_MS);
    // Give it a turn to write the file before anybody could answer it.
    await settle();

    const waiting = await approvals.list(new Date().toISOString());
    expect(waiting).toHaveLength(1);
    // Nobody should have to guess the id to answer it.
    expect(said.join(' ')).toContain('memnox approve');
    expect(said.join(' ')).toContain(waiting[0]?.id ?? 'missing');

    await approvals.answer(
      waiting[0]?.id ?? '',
      HOLD_ANSWER.ONCE,
      'tresor',
      new Date().toISOString(),
    );
    expect(await asking).toEqual({ answer: HOLD_ANSWER.ONCE });
  });

  it('carries a refusal back as a refusal', async () => {
    const approvals = new PendingApprovals(await home());
    const prompt = new RoutedHoldPrompt({
      approvals,
      pollMs: POLL_MS,
    });

    const asking = prompt.ask(request, PATIENT_MS);
    await settle();
    const [waiting] = await approvals.list(new Date().toISOString());
    await approvals.answer(
      waiting?.id ?? '',
      HOLD_ANSWER.DENY,
      'tresor',
      new Date().toISOString(),
    );

    expect(await asking).toEqual({ answer: HOLD_ANSWER.DENY });
  });

  /* A walk-away must not become a yes, and it must not hang the agent either. */
  it('gives up when nobody answers, and leaves nothing behind', async () => {
    const where = await home();
    const approvals = new PendingApprovals(where);
    const prompt = new RoutedHoldPrompt({
      approvals,
      pollMs: POLL_MS,
    });

    expect(await prompt.ask(request, IMPATIENT_MS)).toBeNull();
    // A record that outlived its question is one somebody answers an hour too late.
    expect(await approvals.list(new Date().toISOString())).toEqual([]);
  });

  it('takes the terminal answer when somebody is sitting at one', async () => {
    const approvals = new PendingApprovals(await home());
    const tty: HoldPrompt = {
      ask: async (): Promise<HoldAsked> => ({ answer: HOLD_ANSWER.SESSION }),
    };

    const prompt = new RoutedHoldPrompt({
      approvals,
      tty,
      pollMs: POLL_MS,
    });
    expect(await prompt.ask(request, PATIENT_MS)).toEqual({
      answer: HOLD_ANSWER.SESSION,
    });
  });

  /* A terminal nobody is sitting at must not cancel a remote approval that is about
     to arrive: the headless answer is "not me", not "no". */
  it('still waits for a remote answer when the terminal says nothing', async () => {
    const where = await home();
    const approvals = new PendingApprovals(where);
    const prompt = new RoutedHoldPrompt({
      approvals,
      tty: silent,
      pollMs: POLL_MS,
    });

    const asking = prompt.ask(request, PATIENT_MS);
    await settle();
    const [waiting] = await approvals.list(new Date().toISOString());
    await approvals.answer(
      waiting?.id ?? '',
      HOLD_ANSWER.ONCE,
      'somebody elsewhere',
      new Date().toISOString(),
    );

    expect(await asking).toEqual({ answer: HOLD_ANSWER.ONCE });
  });
});

describe('what the seams now get', () => {
  /* This is the whole point: every seam took an optional hold, none built one, so an
     `ask` rule reached "nobody could be asked" and `ask` meant `deny` everywhere. */
  it('turns an ask into an allow when a person says yes', async () => {
    const where = await home();
    const approvals = new PendingApprovals(where);
    const service = new HoldService(
      new RoutedHoldPrompt({
        approvals,
        pollMs: POLL_MS,
      }),
      PATIENT_MS,
    );

    const holding = service.hold(request);
    await settle();
    const [waiting] = await approvals.list(new Date().toISOString());
    await approvals.answer(
      waiting?.id ?? '',
      HOLD_ANSWER.ONCE,
      'tresor',
      new Date().toISOString(),
    );

    expect((await holding).outcome).toBe(HOLD_OUTCOME.ALLOWED);
  });

  it('reports nobody answering as unattended rather than as a refusal', async () => {
    const approvals = new PendingApprovals(await home());
    const service = new HoldService(
      new RoutedHoldPrompt({
        approvals,
        pollMs: POLL_MS,
      }),
      IMPATIENT_MS,
    );
    expect((await service.hold(request)).outcome).toBe(HOLD_OUTCOME.UNATTENDED);
  });
});
