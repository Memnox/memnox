import { describe, expect, it } from 'vitest';
import {
  CLAIM_ANSWER,
  DECISION_EFFECT,
  type ClaimOutcome,
  type IntendedAction,
  type LeaseHolder,
  type SharedActions,
} from '@memnox/core';
import { DuplicateWorkAuthorizer } from '../src/duplicate-work';
import type { CallAuthorizer, CallVerdict } from '../src/call-authorizer';
import type { ToolCall } from '../src/tool-call';

const HOLDER: LeaseHolder = { agent: 'hermes', sessionId: 'ses_vps', pid: 7 };

const allowing: CallAuthorizer = {
  authorize: async (): Promise<CallVerdict> => ({
    effect: DECISION_EFFECT.ALLOW,
    reason: 'no rule matched',
  }),
};

const refusing: CallAuthorizer = {
  authorize: async (): Promise<CallVerdict> => ({
    effect: DECISION_EFFECT.DENY,
    reason: 'production is frozen',
  }),
};

function register(
  outcome: ClaimOutcome,
  asked: IntendedAction[] = [],
  finished: IntendedAction[] = [],
): SharedActions {
  return {
    claim: async (action) => {
      asked.push(action);
      return outcome;
    },
    finish: async (action) => {
      finished.push(action);
    },
  };
}

const send = (text: string): ToolCall => ({
  name: 'send_message',
  arguments: { channel: '#general', text },
});

/* A lease covers two agents writing one file. The moment work leaves the machine
   there is no path to hold, and two agents posting the same message is the same
   collision one layer out. */
describe('two agents about to send the same message', () => {
  it('refuses the second and names who has it', async () => {
    const seam = new DuplicateWorkAuthorizer(
      allowing,
      register({
        answer: CLAIM_ANSWER.DUPLICATE,
        agent: 'claude-code',
        machine: 'ana-laptop',
        at: '2026-09-22T10:00:00.000Z',
        operation: 'slack.send_message',
      }),
      HOLDER,
      'slack',
    );

    const verdict = await seam.authorize(send('deploy is done'));

    expect(verdict.effect).toBe(DECISION_EFFECT.DENY);
    expect(verdict.reason).toContain('claude-code');
    expect(verdict.reason).toContain('ana-laptop');
  });

  it('lets it through when nobody else has claimed it', async () => {
    const seam = new DuplicateWorkAuthorizer(
      allowing,
      register({ answer: CLAIM_ANSWER.MINE }),
      HOLDER,
      'slack',
    );

    expect((await seam.authorize(send('deploy is done'))).effect).toBe(
      DECISION_EFFECT.ALLOW,
    );
  });

  /* Coordination rather than safety: a register nobody can reach must not be the
     reason an agent cannot work. */
  it('lets it through when the workspace could not be asked', async () => {
    const seam = new DuplicateWorkAuthorizer(
      allowing,
      register({ answer: CLAIM_ANSWER.UNKNOWN, because: 'not enrolled' }),
      HOLDER,
      'slack',
    );

    expect((await seam.authorize(send('deploy is done'))).effect).toBe(
      DECISION_EFFECT.ALLOW,
    );
  });

  it('claims what leaves the machine and never a read', async () => {
    const asked: IntendedAction[] = [];
    const seam = new DuplicateWorkAuthorizer(
      allowing,
      register({ answer: CLAIM_ANSWER.MINE }, asked),
      HOLDER,
      'slack',
    );

    await seam.authorize({ name: 'list_channels', arguments: {} });
    expect(asked).toEqual([]);

    await seam.authorize(send('deploy is done'));
    expect(asked).toEqual([
      {
        operation: 'slack.send_message',
        /* No resource: a channel is where everybody posts, so only this exact
           message is compared, never the channel it goes to. */
        arguments: { channel: '#general', text: 'deploy is done' },
      },
    ]);
  });

  it('refuses a second agent working on the same issue, and says which', async () => {
    const seam = new DuplicateWorkAuthorizer(
      allowing,
      register({
        answer: CLAIM_ANSWER.BUSY,
        agent: 'claude-code',
        machine: 'ana-laptop',
        at: '2026-09-22T10:00:00.000Z',
        operation: 'github.create_comment',
        resource: 'github:acme/api#pull/12',
      }),
      HOLDER,
      'github',
    );

    const verdict = await seam.authorize({
      name: 'close_pull_request',
      arguments: { owner: 'acme', repo: 'api', pull_number: '12' },
    });

    expect(verdict.effect).toBe(DECISION_EFFECT.DENY);
    expect(verdict.reason).toContain('github:acme/api#pull/12');
    expect(verdict.reason).toContain('which of you should own it');
  });

  it('names the thing a call acts on, where its provider names one', async () => {
    const asked: IntendedAction[] = [];
    const seam = new DuplicateWorkAuthorizer(
      allowing,
      register({ answer: CLAIM_ANSWER.MINE }, asked),
      HOLDER,
      'github',
    );

    await seam.authorize({
      name: 'create_comment',
      arguments: { owner: 'acme', repo: 'api', pull_number: '12', body: 'hi' },
    });

    expect(asked[0]?.resource).toBe('github:acme/api#pull/12');
  });

  /* An action the rules are about to refuse needs no claim, or the refused agent
     would hold a thing it never does. */
  it('claims nothing for a call the rules refuse', async () => {
    const asked: IntendedAction[] = [];
    const seam = new DuplicateWorkAuthorizer(
      refusing,
      register({ answer: CLAIM_ANSWER.MINE }, asked),
      HOLDER,
      'slack',
    );

    const verdict = await seam.authorize(send('deploy is done'));

    expect(verdict.reason).toBe('production is frozen');
    expect(asked).toEqual([]);
  });
});

/* `close_pull_request` is in nobody's verb table and is plainly work on that
   pull request; a read that names one is still a read. */
describe('what is worth claiming at all', () => {
  it('claims a call it cannot classify that names one thing', async () => {
    const asked: IntendedAction[] = [];
    const seam = new DuplicateWorkAuthorizer(
      allowing,
      register({ answer: CLAIM_ANSWER.MINE }, asked),
      HOLDER,
      'github',
    );

    await seam.authorize({
      name: 'close_pull_request',
      arguments: { owner: 'acme', repo: 'api', pull_number: '12' },
    });

    expect(asked).toHaveLength(1);
  });

  it('claims nothing for a read, whatever it names', async () => {
    const asked: IntendedAction[] = [];
    const seam = new DuplicateWorkAuthorizer(
      allowing,
      register({ answer: CLAIM_ANSWER.MINE }, asked),
      HOLDER,
      'github',
    );

    await seam.authorize({
      name: 'get_pull_request',
      arguments: { owner: 'acme', repo: 'api', pull_number: '12' },
    });

    expect(asked).toEqual([]);
  });
});

/* A whole UUID in a sentence an agent reads out is noise; the first segment
   still tells two machines apart. */
describe('what the other machine is called', () => {
  it('keeps the name a person gave it and shortens a bare id', async () => {
    const named = new DuplicateWorkAuthorizer(
      allowing,
      register({
        answer: CLAIM_ANSWER.DUPLICATE,
        agent: 'claude-code',
        machine: 'ana-laptop',
        at: 'just now',
        operation: 'slack.send_message',
      }),
      HOLDER,
      'slack',
    );
    expect((await named.authorize(send('hi'))).reason).toContain('on ana-laptop');

    const unnamed = new DuplicateWorkAuthorizer(
      allowing,
      register({
        answer: CLAIM_ANSWER.DUPLICATE,
        agent: 'claude-code',
        machine: '0dc8ce0c-1a21-4fd5-8bfb-eb70eb3d52f8',
        at: 'just now',
        operation: 'slack.send_message',
      }),
      HOLDER,
      'slack',
    );
    const reason = (await unnamed.authorize(send('hi'))).reason;
    expect(reason).toContain('on 0dc8ce0c');
    expect(reason).not.toContain('eb70eb3d52f8');
  });
});

/* A claim means "doing this now": it is let go the moment the call returns,
   and only once the last of two identical calls in flight has. */
describe('holding a claim only while the call runs', () => {
  it('finishes the claim when the call returns, and not before', async () => {
    const finished: IntendedAction[] = [];
    const seam = new DuplicateWorkAuthorizer(
      allowing,
      register({ answer: CLAIM_ANSWER.MINE }, [], finished),
      HOLDER,
      'slack',
    );

    await seam.authorize(send('hi'));
    await seam.authorize(send('hi'));
    await seam.settle(send('hi'));
    expect(finished).toEqual([]);

    await seam.settle(send('hi'));
    expect(finished).toHaveLength(1);
    expect(finished[0]?.operation).toBe('slack.send_message');
  });

  /* An agent that ends its session right after a call takes the proxy with it,
     and an unfinished claim would leave the thing busy with nobody on it. */
  it('lets go of everything still held when the proxy goes away', async () => {
    const finished: IntendedAction[] = [];
    const seam = new DuplicateWorkAuthorizer(
      allowing,
      register({ answer: CLAIM_ANSWER.MINE }, [], finished),
      HOLDER,
      'slack',
    );
    await seam.authorize(send('one'));
    await seam.authorize(send('two'));

    await seam.close();
    await seam.settle(send('one'));

    expect(finished.map((each) => each.arguments['text'])).toEqual(['one', 'two']);
  });

  /* A returned call starts its finish without waiting, and a proxy exiting at
     that moment used to cut it off and leave the claim standing. */
  it('waits for a finish already on its way before the proxy goes', async () => {
    let arrived = false;
    const slow: SharedActions = {
      claim: async () => ({ answer: CLAIM_ANSWER.MINE }),
      finish: async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        arrived = true;
      },
    };
    const seam = new DuplicateWorkAuthorizer(allowing, slow, HOLDER, 'slack');
    await seam.authorize(send('one'));

    void seam.settle(send('one'));
    await seam.close();

    expect(arrived).toBe(true);
  });

  it('has nothing to finish for a call it refused or never claimed', async () => {
    const finished: IntendedAction[] = [];
    const seam = new DuplicateWorkAuthorizer(
      allowing,
      register(
        {
          answer: CLAIM_ANSWER.DUPLICATE,
          agent: 'claude-code',
          at: 'just now',
          operation: 'slack.send_message',
        },
        [],
        finished,
      ),
      HOLDER,
      'slack',
    );

    await seam.authorize(send('hi'));
    await seam.settle(send('hi'));
    await seam.settle({ name: 'list_channels', arguments: {} });

    expect(finished).toEqual([]);
  });
});
