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
  ask: async () => (answer === null ? null : { answer }),
});

describe('holding a call for a person', () => {
  it('allows once, and asks again next time', async () => {
    const prompt = { ask: vi.fn(async () => ({ answer: HOLD_ANSWER.ONCE })) };
    const service = new HoldService(prompt);

    expect(isAllowed(await service.hold(REQUEST))).toBe(true);
    expect(isAllowed(await service.hold(REQUEST))).toBe(true);
    expect(prompt.ask).toHaveBeenCalledTimes(2);
  });

  it('allows for the session without asking a second time', async () => {
    const prompt = { ask: vi.fn(async () => ({ answer: HOLD_ANSWER.SESSION })) };
    const service = new HoldService(prompt);

    await service.hold(REQUEST);
    const second = await service.hold(REQUEST);

    expect(second.fromSessionGrant).toBe(true);
    expect(prompt.ask).toHaveBeenCalledTimes(1);
  });

  it('scopes a session grant to that session and the action it named', async () => {
    const service = new HoldService(answering(HOLD_ANSWER.SESSION));
    await service.hold(REQUEST);

    expect(await service.hasSessionGrant(REQUEST)).toBe(true);
    expect(await service.hasSessionGrant({ ...REQUEST, sessionId: 'ses_2' })).toBe(false);
    // The question named the action, so the same action on another target is covered.
    expect(await service.hasSessionGrant({ ...REQUEST, fingerprint: 'other' })).toBe(
      true,
    );
    expect(
      await service.hasSessionGrant({
        ...REQUEST,
        operation: 'something.else',
        fingerprint: 'x',
      }),
    ).toBe(false);
  });

  it('grants a delete for that one call, never by name', async () => {
    const service = new HoldService(answering(HOLD_ANSWER.SESSION));
    const deleting = { ...REQUEST, class: 'destructive' };
    await service.hold(deleting);

    expect(await service.hasSessionGrant(deleting)).toBe(true);
    expect(await service.hasSessionGrant({ ...deleting, fingerprint: 'other' })).toBe(
      false,
    );
  });

  it('stops asking after the second yes to the same action in a session', async () => {
    const prompt = { ask: vi.fn(async () => ({ answer: HOLD_ANSWER.ONCE })) };
    const service = new HoldService(prompt);

    const first = await service.hold(REQUEST);
    const second = await service.hold({ ...REQUEST, fingerprint: 'another call' });
    const third = await service.hold({ ...REQUEST, fingerprint: 'a third' });

    expect(first.learned).toBeUndefined();
    expect(second.learned).toBe(true);
    expect(third.fromSessionGrant).toBe(true);
    expect(prompt.ask).toHaveBeenCalledTimes(2);
    // A new session starts over.
    await service.hold({ ...REQUEST, sessionId: 'ses_2' });
    expect(prompt.ask).toHaveBeenCalledTimes(3);
  });

  it('never learns a delete, however many times it was allowed', async () => {
    const prompt = { ask: vi.fn(async () => ({ answer: HOLD_ANSWER.ONCE })) };
    const service = new HoldService(prompt);
    const deleting = { ...REQUEST, class: 'destructive' };

    for (const fingerprint of ['a', 'b', 'c'])
      await service.hold({ ...deleting, fingerprint });
    expect(prompt.ask).toHaveBeenCalledTimes(3);
  });

  it('does not count a no toward learning', async () => {
    const answers = [HOLD_ANSWER.DENY, HOLD_ANSWER.ONCE, HOLD_ANSWER.ONCE];
    const prompt = {
      ask: vi.fn(async () => ({ answer: answers.shift() ?? HOLD_ANSWER.ONCE })),
    };
    const service = new HoldService(prompt);

    await service.hold(REQUEST);
    const afterOneYes = await service.hold({ ...REQUEST, fingerprint: 'b' });
    expect(afterOneYes.learned).toBeUndefined();
  });

  it('forgets a session’s grants when the session ends', async () => {
    const service = new HoldService(answering(HOLD_ANSWER.SESSION));
    await service.hold(REQUEST);
    service.forget('ses_1');
    expect(await service.hasSessionGrant(REQUEST)).toBe(false);
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
    expect(question).toContain('Claude-code wants to merge_pull_request');
    expect(question).toContain('merge_pull_request github');
    expect(question).toContain('production is frozen');
    expect(question).toContain('1. Yes, once');
    expect(question).toContain('2. Yes, for the rest of this session');
    expect(question).toContain('3. No');
  });

  it('shows the command as typed, the reason once, and where else to answer', () => {
    const reason = 'sometimes it really is the build directory, so a person should look';
    const question = questionFor({
      ...REQUEST,
      operation: 'filesystem.delete',
      target: '/tmp/build',
      command: 'rm -rf /tmp/build',
      reason,
      evidence: [`    rule  shell-ask: ${reason}`],
      approvalId: 'apr_1',
    });

    expect(question).toContain('wants to delete files');
    expect(question).toContain('rm -rf /tmp/build');
    expect(question.split('build directory')).toHaveLength(2);
    expect(question).toContain('Rule  shell-ask');
    expect(question).toContain('memnox approve apr_1');
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
    ['1', HOLD_ANSWER.ONCE],
    ['2', HOLD_ANSWER.SESSION],
    ['3', HOLD_ANSWER.DENY],
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

    expect(await asking).toEqual({ answer: expected });
  });

  /* An edit is not an approval: it goes back through the rules from the start, or "[e]"
     would be the way around every one of them. */
  it('reads an edit as a replacement command, and never as a yes', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const prompt = new TtyHoldPrompt({ open: () => ({ input, output }) });

    const asking = prompt.ask(
      { ...REQUEST, command: 'railway volume delete pg-prod' },
      5000,
    );
    input.write('e\n');
    await new Promise((resolve) => setImmediate(resolve));
    input.write('railway volume delete pg-staging\n');

    expect(await asking).toEqual({
      answer: HOLD_ANSWER.EDIT,
      command: 'railway volume delete pg-staging',
    });
  });

  // Offered only when there is a command to edit; a tool call has no line to fix.
  it('offers the edit only when there is a command', () => {
    expect(questionFor(REQUEST)).not.toContain('Edit the command');
    expect(questionFor({ ...REQUEST, command: 'git push --force' })).toContain(
      '3. Edit the command first',
    );
  });

  it('shows the evidence that produced the verdict', () => {
    const shown = questionFor({
      ...REQUEST,
      evidence: ['    state  freeze:payments — troubleshooting (1h left, moise)'],
    });

    expect(shown).toContain('freeze:payments');
  });

  it('gives up rather than holding the agent forever', async () => {
    const prompt = new TtyHoldPrompt({
      open: () => ({ input: new PassThrough(), output: new PassThrough() }),
    });
    // Nobody types anything; a walk-away must never become a yes.
    expect(await prompt.ask(REQUEST, 20)).toBeNull();
  });
});

describe('the terminal prompt, one key at a time', () => {
  const terminal = () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const raw: boolean[] = [];
    let drawn = '';
    output.on('data', (chunk: Buffer) => {
      drawn += chunk.toString();
    });
    const streams = {
      input,
      output,
      columns: 90,
      setRawMode: (on: boolean) => {
        raw.push(on);
      },
    };
    return { streams, input, raw, drawn: () => drawn };
  };

  it('moves the arrow and takes what enter lands on', async () => {
    const { streams, input, raw } = terminal();
    const asking = new TtyHoldPrompt({ open: () => streams }).ask(REQUEST, 5000);

    input.write('\u001b[B');
    input.write('\r');

    expect(await asking).toEqual({ answer: HOLD_ANSWER.SESSION });
    // Raw mode is always given back, or the person's shell is left broken.
    expect(raw).toEqual([true, false]);
  });

  it('takes a number on its own, with no enter', async () => {
    const { streams, input } = terminal();
    const asking = new TtyHoldPrompt({ open: () => streams }).ask(REQUEST, 5000);

    input.write('1');

    expect(await asking).toEqual({ answer: HOLD_ANSWER.ONCE });
  });

  it.each([
    ['escape', '\u001b'],
    ['ctrl-c', '\u0003'],
  ])('reads %s as no, never as a yes by accident', async (_name, key) => {
    const { streams, input } = terminal();
    const asking = new TtyHoldPrompt({ open: () => streams }).ask(REQUEST, 5000);

    input.write(key);

    expect(await asking).toEqual({ answer: HOLD_ANSWER.DENY });
  });

  it('leaves one line in the scrollback saying what was decided', async () => {
    const { streams, input, drawn } = terminal();
    const asking = new TtyHoldPrompt({ open: () => streams }).ask(
      { ...REQUEST, command: 'git push --force' },
      5000,
    );

    input.write('4');
    await asking;

    expect(drawn()).toContain('╭─ Memnox');
    expect(drawn()).toContain('Memnox · git push --force · refused');
  });

  it('gives the edit a line with the command already in it', async () => {
    const { streams, input } = terminal();
    const asking = new TtyHoldPrompt({ open: () => streams }).ask(
      { ...REQUEST, command: 'railway volume delete pg-prod' },
      5000,
    );

    input.write('3');
    await new Promise((resolve) => setImmediate(resolve));
    input.write('\u0015railway volume delete pg-staging\n');

    expect(await asking).toEqual({
      answer: HOLD_ANSWER.EDIT,
      command: 'railway volume delete pg-staging',
    });
  });

  it('refuses when the clock runs out with nobody at the keys', async () => {
    const { streams, raw } = terminal();
    let clock = 0;
    const asking = new TtyHoldPrompt({ open: () => streams, now: () => clock }).ask(
      REQUEST,
      1500,
    );
    clock = 2000;

    expect(await asking).toBeNull();
    expect(raw).toEqual([true, false]);
  });
});
