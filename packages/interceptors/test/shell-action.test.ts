import { describe, expect, it } from 'vitest';
import {
  actionFingerprint,
  CLAIM_ANSWER,
  type ClaimOutcome,
  type IntendedAction,
  type LeaseHolder,
  type SharedActions,
} from '@memnox/core';
import { claimShellAction, shellAction } from '../src/shell-action';

const ACME = () => ({ owner: 'acme', repo: 'api' });
const NOWHERE = () => null;
const UNKNOWN = { action: 'gh.unknown', class: 'unknown' };
const HOLDER: LeaseHolder = { agent: 'codex-cli', sessionId: 'ses_laptop', pid: 7 };

/* `gh pr close 12` here and `close_pull_request` through the proxy are one piece of
   work, and the two surfaces used to never meet. */
describe('the outward action a command line takes', () => {
  it('names a pull request the way the proxy names it', () => {
    const close = shellAction('gh', ['pr', 'close', '12'], UNKNOWN, ACME);
    expect(close?.resource).toBe('github:acme/api#pull/12');

    const byFlag = shellAction(
      'gh',
      ['pr', 'comment', '12', '-b', 'hi', '-R', 'Acme/API'],
      UNKNOWN,
      NOWHERE,
    );
    expect(byFlag?.resource).toBe('github:acme/api#pull/12');

    const byUrl = shellAction(
      'gh',
      ['issue', 'close', 'https://github.com/acme/api/issues/9'],
      UNKNOWN,
      NOWHERE,
    );
    expect(byUrl?.resource).toBe('github:acme/api#issue/9');
  });

  it('never claims a read, whatever it names', () => {
    expect(
      shellAction(
        'gh',
        ['pr', 'view', '12'],
        { action: 'gh.pr-view', class: 'read' },
        ACME,
      ),
    ).toBeNull();
    expect(shellAction('gh', ['pr', 'diff', '12'], UNKNOWN, ACME)).toBeNull();
  });

  /* A pull request number without its repository is not one thing. */
  it('names nothing where the repository cannot be told', () => {
    expect(shellAction('gh', ['pr', 'close', '12'], UNKNOWN, NOWHERE)).toBeNull();
  });

  it('claims a request that sends something and never one that only fetches', () => {
    const network = { action: 'http.request', class: 'network', target: 'slack.com' };
    const post = shellAction(
      'curl',
      ['-X', 'POST', 'https://slack.com/api/chat.postMessage', '-d', 'text=hi'],
      network,
      NOWHERE,
    );
    expect(post).not.toBeNull();
    expect(post?.resource).toBeUndefined();
    expect(
      shellAction(
        'curl',
        ['https://slack.com/api/chat.postMessage', '--data=text=hi'],
        network,
      ),
    ).not.toBeNull();

    expect(shellAction('curl', ['https://example.com'], network)).toBeNull();
    expect(shellAction('curl', ['-X', 'GET', 'https://example.com'], network)).toBeNull();
  });

  it('claims a command that writes, and matches it only against the same line', () => {
    const write = { action: 'kubectl.apply', class: 'write', target: 'x.yaml' };
    const one = shellAction('kubectl', ['apply', '-f', 'x.yaml'], write, NOWHERE);
    const same = shellAction('kubectl', ['apply', '-f', 'x.yaml'], write, NOWHERE);
    const other = shellAction('kubectl', ['apply', '-f', 'y.yaml'], write, NOWHERE);
    if (one === null || same === null || other === null) throw new Error('not claimed');

    expect(actionFingerprint(one)).toBe(actionFingerprint(same));
    expect(actionFingerprint(one)).not.toBe(actionFingerprint(other));
  });
});

function register(answer: ClaimOutcome): SharedActions & { asked: IntendedAction[] } {
  const asked: IntendedAction[] = [];
  return {
    asked,
    claim: async (action) => {
      asked.push(action);
      return answer;
    },
    finish: async () => undefined,
  };
}

describe('asking before the command runs', () => {
  it('refuses with the name of the agent that has it', async () => {
    const reason = await claimShellAction(
      {
        operation: 'gh.unknown',
        arguments: { 0: 'pr' },
        resource: 'github:acme/api#pull/12',
      },
      register({
        answer: CLAIM_ANSWER.BUSY,
        agent: 'claude-code',
        machine: 'ana-laptop',
        at: '10:00',
        operation: 'github.create_comment',
        resource: 'github:acme/api#pull/12',
      }),
      HOLDER,
    );

    expect('refused' in reason ? reason.refused : '').toContain(
      'claude-code on ana-laptop has been working on github:acme/api#pull/12',
    );
  });

  /* Coordination rather than safety: a control plane that cannot answer is never
     the reason a command stops. */
  it('lets the command run when nobody could tell', async () => {
    const unreachable = register({ answer: CLAIM_ANSWER.UNKNOWN, because: 'offline' });
    const mine = register({ answer: CLAIM_ANSWER.MINE });
    const action = { operation: 'kubectl.apply', arguments: { 0: 'apply' } };

    const offline = await claimShellAction(action, unreachable, HOLDER);
    const held = await claimShellAction(action, mine, HOLDER);

    expect('refused' in offline).toBe(false);
    expect('refused' in held).toBe(false);
    if ('release' in held) await held.release();
  });

  /* Held while the command runs and let go when it exits, so the thing is free
     the moment the work is done rather than minutes later. */
  it('finishes the claim when the command is done', async () => {
    const finished: IntendedAction[] = [];
    const actions: SharedActions = {
      claim: async () => ({ answer: CLAIM_ANSWER.MINE }),
      finish: async (action) => {
        finished.push(action);
      },
    };
    const action = { operation: 'kubectl.apply', arguments: { 0: 'apply' } };

    const held = await claimShellAction(action, actions, HOLDER);
    expect(finished).toEqual([]);
    if ('release' in held) await held.release();

    expect(finished).toEqual([action]);
  });
});
