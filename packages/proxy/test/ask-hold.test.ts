import { describe, expect, it, vi } from 'vitest';
import {
  DECISION_EFFECT,
  HOLD_ANSWER,
  HoldService,
  type HoldAnswer,
  type HoldPrompt,
} from '@memnox/core';
import { FirewallSession } from '../src/firewall-session';
import { ToolFilter } from '../src/tool-filter';
import type { CallAuthorizer, CallVerdict } from '../src/call-authorizer';
import type { McpCallRecord } from '../src/result-guard';

const ASK: CallVerdict = {
  effect: DECISION_EFFECT.ASK,
  reason: 'merging on a Friday needs a person',
  alternative: { action: 'git.push', resource: 'a branch', note: 'open a PR' },
};

const asking: CallAuthorizer = { authorize: async () => ASK };

function session(hold?: HoldService) {
  const toServer = vi.fn((_payload: string) => true);
  const toClient = vi.fn((_payload: string) => undefined);
  const instance = new FirewallSession({
    filter: new ToolFilter(),
    authorizer: asking,
    channel: { toServer, toClient },
    log: () => {},
    server: 'github',
    agent: 'claude-code',
    sessionId: 'ses_1',
    ...(hold === undefined ? {} : { hold }),
  });
  return { instance, toServer, toClient };
}

const CALL = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'tools/call',
  params: { name: 'merge_pull_request', arguments: { pr: 41 } },
});

const prompting = (answer: HoldAnswer | null): HoldPrompt => ({
  ask: async () => (answer === null ? null : { answer }),
});

describe('an ASK holds the call', () => {
  it('reaches the server only after a person allows it', async () => {
    const hold = new HoldService(prompting(HOLD_ANSWER.ONCE));
    const { instance, toServer, toClient } = session(hold);

    await instance.fromClient(CALL);

    expect(toServer).toHaveBeenCalledTimes(1);
    expect(toClient).not.toHaveBeenCalled();
  });

  it('never reaches the server when a person denies it', async () => {
    const hold = new HoldService(prompting(HOLD_ANSWER.DENY));
    const { instance, toServer, toClient } = session(hold);

    await instance.fromClient(CALL);

    expect(toServer).not.toHaveBeenCalled();
    const reply = JSON.parse((toClient.mock.calls[0] as string[])[0] as string);
    expect(reply.result.isError).toBe(true);
    expect(reply.result.content[0].text).toContain('A person denied');
  });

  it('asks once for a session grant, then lets the next identical call straight through', async () => {
    const ask = vi.fn(async () => ({ answer: HOLD_ANSWER.SESSION }));
    const hold = new HoldService({ ask });
    const { instance, toServer } = session(hold);

    await instance.fromClient(CALL);
    await instance.fromClient(CALL);

    expect(ask).toHaveBeenCalledTimes(1);
    expect(toServer).toHaveBeenCalledTimes(2);
  });

  it('denies with a way forward when nobody can be asked', async () => {
    const { instance, toServer, toClient } = session();

    await instance.fromClient(CALL);

    expect(toServer).not.toHaveBeenCalled();
    const reply = JSON.parse((toClient.mock.calls[0] as string[])[0] as string);
    expect(reply.result.content[0].text).toContain('nobody could be asked');
    // The alternative still rides all the way to the client, or the refusal is a dead end.
    expect(JSON.stringify(reply)).toContain('git.push');
  });

  it('denies when nobody answers in time, rather than holding the agent forever', async () => {
    const hold = new HoldService(prompting(null));
    const { instance, toServer } = session(hold);

    await instance.fromClient(CALL);
    expect(toServer).not.toHaveBeenCalled();
  });
});

/* A call left `openCalls` only when its result came back, and a server may drop a
   cancelled request, so they piled up with no row. Worse, a call held for a person was
   still sent on a late yes, after the agent had given up on it. */
describe('a call the client cancels', () => {
  const cancel = (requestId: number): string =>
    JSON.stringify({
      jsonrpc: '2.0',
      method: 'notifications/cancelled',
      params: { requestId },
    });

  function watched(authorizer: CallAuthorizer, hold?: HoldService) {
    const toServer = vi.fn((_payload: string) => true);
    const toClient = vi.fn((_payload: string) => undefined);
    const rows: McpCallRecord[] = [];
    const instance = new FirewallSession({
      filter: new ToolFilter(),
      authorizer,
      channel: { toServer, toClient },
      log: () => {},
      record: (row) => rows.push(row),
      ...(hold === undefined ? {} : { hold }),
    });
    const sent = (): string[] => toServer.mock.calls.map(([payload]) => payload);
    return { instance, toClient, rows, sent };
  }

  it('sends nothing when the client cancels while a person is still deciding', async () => {
    let answer: (value: { answer: HoldAnswer }) => void = () => undefined;
    let asked: () => void = () => undefined;
    const question = new Promise<void>((resolve) => (asked = resolve));
    const hold = new HoldService({
      ask: () => {
        asked();
        return new Promise((resolve) => (answer = resolve));
      },
    });
    const { instance, toClient, rows, sent } = watched(asking, hold);

    const held = instance.fromClient(CALL);
    // The person is being asked; only now is the call truly held.
    await question;
    await instance.fromClient(cancel(1));
    answer({ answer: HOLD_ANSWER.ONCE });
    await held;

    expect(sent().some((payload) => payload.includes('tools/call'))).toBe(false);
    // The cancellation itself still travels, so the server can stop anything it began.
    expect(sent().some((payload) => payload.includes('notifications/cancelled'))).toBe(
      true,
    );
    // Nobody is waiting for a reply to a call they cancelled.
    expect(toClient).not.toHaveBeenCalled();
    expect(rows.map((row) => row.reason)).toEqual([expect.stringContaining('cancelled')]);
  });

  it('closes a call already sent, with a row that says it was cancelled', async () => {
    const allowing: CallAuthorizer = {
      authorize: async () => ({ effect: DECISION_EFFECT.ALLOW, reason: 'fine' }),
    };
    const { instance, rows } = watched(allowing);

    await instance.fromClient(CALL);
    expect(rows).toEqual([]);
    await instance.fromClient(cancel(1));

    expect(rows.map((row) => row.tool)).toEqual(['merge_pull_request']);
    expect(rows[0]?.reason).toContain('cancelled');

    // A result that turns up after all answers no open call, and adds no second row.
    instance.fromServer(
      JSON.stringify({ jsonrpc: '2.0', id: 1, result: { content: [] } }),
    );
    expect(rows).toHaveLength(1);
  });

  it('ignores a cancellation for a call it never saw', async () => {
    const { instance, rows, sent } = watched(asking);
    await instance.fromClient(cancel(99));
    expect(rows).toEqual([]);
    expect(sent()).toHaveLength(1);
  });
});
