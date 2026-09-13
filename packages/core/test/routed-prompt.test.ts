import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RoutedHoldPrompt } from '../src/gate/routed-prompt';
import { PendingApprovals } from '../src/gate/pending';
import {
  HOLD_ANSWER,
  DEFAULT_HOLD_TIMEOUT_MS,
  DEFAULT_UNATTENDED_HOLD_TIMEOUT_MS,
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
 *
 * Nothing here sleeps a fixed amount and hopes. A test that waited 30ms for the file
 * to appear passed on a laptop and failed on a loaded CI runner, which is a flake
 * shaped exactly like the bug it was written to catch: an answer that arrives late
 * reads as nobody having answered.
 */
/* The 30s deadlines below are well clear of how long `held` can poll: vitest's default
   five seconds is the same wall-clock bound that made the sibling suite flake. */
const POLL_MS = 10;
const PATIENT_MS = 10_000;
const IMPATIENT_MS = 150;

/** Waits for the held call to be written down, however slow the machine is. */
async function held(approvals: PendingApprovals): Promise<string> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    const [waiting] = await approvals.list(new Date().toISOString());
    if (waiting !== undefined) return waiting.id;
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  throw new Error('the held call was never written down');
}

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
    // It is written down before anybody could answer it, however slow the machine.
    const waiting = await held(approvals);
    // Nobody should have to guess the id to answer it.
    expect(said.join(' ')).toContain('memnox approve');
    expect(said.join(' ')).toContain(waiting);

    await approvals.answer(waiting, HOLD_ANSWER.ONCE, 'tresor', new Date().toISOString());
    expect(await asking).toEqual({ answer: HOLD_ANSWER.ONCE });
  }, 30_000);

  it('carries a refusal back as a refusal', async () => {
    const approvals = new PendingApprovals(await home());
    const prompt = new RoutedHoldPrompt({
      approvals,
      pollMs: POLL_MS,
    });

    const asking = prompt.ask(request, PATIENT_MS);
    const waiting = await held(approvals);
    await approvals.answer(waiting, HOLD_ANSWER.DENY, 'tresor', new Date().toISOString());

    expect(await asking).toEqual({ answer: HOLD_ANSWER.DENY });
  }, 30_000);

  /* A walk-away must not become a yes, and it must not hang the agent either. */
  it('gives up when nobody answers, and leaves nothing behind', async () => {
    const where = await home();
    const approvals = new PendingApprovals(where);
    const prompt = new RoutedHoldPrompt({
      approvals,
      pollMs: POLL_MS,
    });

    /* Not null: null is "there was nobody to ask", and a question that was written
       down and waited on is a different thing. The agent reads the two differently. */
    expect(await prompt.ask(request, IMPATIENT_MS)).toEqual({
      unanswered: HOLD_OUTCOME.TIMED_OUT,
    });
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
    const waiting = await held(approvals);
    await approvals.answer(
      waiting,
      HOLD_ANSWER.ONCE,
      'somebody elsewhere',
      new Date().toISOString(),
    );

    expect(await asking).toEqual({ answer: HOLD_ANSWER.ONCE });
  }, 30_000);
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
    const waiting = await held(approvals);
    await approvals.answer(waiting, HOLD_ANSWER.ONCE, 'tresor', new Date().toISOString());

    expect((await holding).outcome).toBe(HOLD_OUTCOME.ALLOWED);
  }, 30_000);

  it('reports nobody answering as a timeout rather than as a refusal', async () => {
    const approvals = new PendingApprovals(await home());
    const service = new HoldService(
      new RoutedHoldPrompt({
        approvals,
        pollMs: POLL_MS,
      }),
      IMPATIENT_MS,
    );
    /* Refused either way, and never as somebody's denial. Timed out rather than
       unattended, because this machine could be asked and was: an approver who was
       merely slow must not reach the agent wearing the words of a person who said no. */
    expect((await service.hold(request)).outcome).toBe(HOLD_OUTCOME.TIMED_OUT);
  });
});

/**
 * Two minutes is right for somebody already reading the prompt and wrong for a machine
 * nobody is sitting at: the question has to reach a person who is not there yet and the
 * answer has to travel back. One window for both meant the remote half could not finish
 * inside it.
 */
describe('how long a held call waits', () => {
  it('gives a terminal the short window, since somebody is already looking', () => {
    expect(DEFAULT_HOLD_TIMEOUT_MS).toBe(120_000);
  });

  it('gives an unattended machine longer, because the answer has to travel', () => {
    expect(DEFAULT_UNATTENDED_HOLD_TIMEOUT_MS).toBeGreaterThan(DEFAULT_HOLD_TIMEOUT_MS);
  });

  it('leaves room for the round trip the answer actually makes', () => {
    /* Both legs ride the heartbeat, so the window has to hold a trip up, a person, and
       a trip back. Measured at a minute each way before this changed, which consumed
       the whole of the old window and left nobody any time to read it. */
    const roundTripMs = 2 * 60_000;
    expect(DEFAULT_UNATTENDED_HOLD_TIMEOUT_MS).toBeGreaterThan(roundTripMs);
  });
});
