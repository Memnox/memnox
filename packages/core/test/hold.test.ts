import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_HOLD_TIMEOUT_MS,
  describeHold,
  HOLD_ANSWER,
  HOLD_OUTCOME,
  HoldService,
  isAllowed,
  type HoldAnswer,
  type HoldPrompt,
  type HoldRequest,
} from '../src/gate/hold';
import { questionFor, TtyHoldPrompt } from '../src/gate/tty-prompt';

const REQUEST: HoldRequest = {
  sessionId: 'ses_1',
  agent: 'claude-code',
  operation: 'merge_pull_request',
  target: 'github',
  fingerprint: 'abc123',
  reason: 'production is frozen',
};

const answering = (answer: HoldAnswer | null): HoldPrompt => ({
  ask: async () => answer,
});

describe('holding a call for a person', () => {
  it('allows once, and asks again next time', async () => {
    const prompt = { ask: vi.fn(async () => HOLD_ANSWER.ONCE) };
    const service = new HoldService(prompt);

    expect(isAllowed(await service.hold(REQUEST))).toBe(true);
    expect(isAllowed(await service.hold(REQUEST))).toBe(true);
    expect(prompt.ask).toHaveBeenCalledTimes(2);
  });

  it('allows for the session without asking a second time', async () => {
    const prompt = { ask: vi.fn(async () => HOLD_ANSWER.SESSION) };
    const service = new HoldService(prompt);

    await service.hold(REQUEST);
    const second = await service.hold(REQUEST);

    expect(second.fromSessionGrant).toBe(true);
    expect(prompt.ask).toHaveBeenCalledTimes(1);
  });

  it('scopes a session grant to that session and that call', async () => {
    const service = new HoldService(answering(HOLD_ANSWER.SESSION));
    await service.hold(REQUEST);

    expect(service.hasSessionGrant(REQUEST)).toBe(true);
    expect(service.hasSessionGrant({ ...REQUEST, sessionId: 'ses_2' })).toBe(false);
    expect(service.hasSessionGrant({ ...REQUEST, fingerprint: 'other' })).toBe(false);
  });

  it('forgets a session’s grants when the session ends', async () => {
    const service = new HoldService(answering(HOLD_ANSWER.SESSION));
    await service.hold(REQUEST);
    service.forget('ses_1');
    expect(service.hasSessionGrant(REQUEST)).toBe(false);
  });

  it('denies when a person says no', async () => {
    const result = await new HoldService(answering(HOLD_ANSWER.DENY)).hold(REQUEST);
    expect(result.outcome).toBe(HOLD_OUTCOME.DENIED);
    expect(describeHold(result, REQUEST)).toContain('A person denied');
  });

  it('denies when there is nobody to ask, and says how to fix that', async () => {
    const result = await new HoldService(answering(null)).hold(REQUEST);
    expect(result.outcome).toBe(HOLD_OUTCOME.UNATTENDED);
    expect(describeHold(result, REQUEST)).toContain('memnox run');
  });

  it('fails closed when the prompt itself throws', async () => {
    const angry: HoldPrompt = {
      ask: async () => {
        throw new Error('/dev/tty vanished');
      },
    };
    const result = await new HoldService(angry).hold(REQUEST);
    expect(isAllowed(result)).toBe(false);
    expect(result.outcome).toBe(HOLD_OUTCOME.UNATTENDED);
  });

  it('holds for two minutes by default, not forever', () => {
    expect(DEFAULT_HOLD_TIMEOUT_MS).toBe(120_000);
  });
});

describe('the terminal prompt', () => {
  it('names the agent, the call and the reason, and offers three answers', () => {
    const question = questionFor(REQUEST);
    expect(question).toContain('claude-code wants to merge_pull_request github');
    expect(question).toContain('production is frozen');
    expect(question).toContain('[a] allow once');
    expect(question).toContain('[s] allow for this session');
    expect(question).toContain('[d] deny');
  });

  it('returns null when there is no controlling terminal', async () => {
    const prompt = new TtyHoldPrompt({
      open: () => {
        throw new Error('ENXIO');
      },
    });
    expect(await prompt.ask(REQUEST, 10)).toBeNull();
  });

  it.each([
    ['a', HOLD_ANSWER.ONCE],
    ['y', HOLD_ANSWER.ONCE],
    ['s', HOLD_ANSWER.SESSION],
    ['d', HOLD_ANSWER.DENY],
    ['n', HOLD_ANSWER.DENY],
    ['what?', HOLD_ANSWER.DENY],
    ['', HOLD_ANSWER.DENY],
  ])('reads "%s" as %s, so anything unrecognised is a deny', async (typed, expected) => {
    const input = new PassThrough();
    const output = new PassThrough();
    const prompt = new TtyHoldPrompt({ open: () => ({ input, output }) });

    const asking = prompt.ask(REQUEST, 5000);
    input.write(`${typed}
`);

    expect(await asking).toBe(expected);
  });

  it('gives up rather than holding the agent forever', async () => {
    const prompt = new TtyHoldPrompt({
      open: () => ({ input: new PassThrough(), output: new PassThrough() }),
    });
    // Nobody types anything; a walk-away must never become a yes.
    expect(await prompt.ask(REQUEST, 20)).toBeNull();
  });
});
