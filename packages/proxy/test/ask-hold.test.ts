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
  ask: async () => answer,
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
    const ask = vi.fn(async () => HOLD_ANSWER.SESSION);
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
