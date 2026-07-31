import { describe, expect, it } from 'vitest';
import { DECISION_EFFECT } from '@memnox/core';
import {
  FirewallSession,
  ToolFilter,
  UngovernedAuthorizer,
  type CallAuthorizer,
  type CallVerdict,
  type FirewallChannel,
  type JsonRpcMessage,
  type ToolCall,
} from '../src/index';

class RecordingChannel implements FirewallChannel {
  readonly server: string[] = [];
  readonly client: string[] = [];
  /** Set false to stand in for a wrapped server that has exited. */
  accepting = true;

  toServer(payload: string): boolean {
    if (!this.accepting) return false;
    this.server.push(payload);
    return true;
  }

  toClient(payload: string): void {
    this.client.push(payload);
  }

  lastToClient(): JsonRpcMessage {
    return JSON.parse(this.client[this.client.length - 1] ?? '{}') as JsonRpcMessage;
  }
}

class StubAuthorizer implements CallAuthorizer {
  readonly asked: string[] = [];
  readonly calls: ToolCall[] = [];

  constructor(private readonly verdict: CallVerdict) {}

  async authorize(call: ToolCall): Promise<CallVerdict> {
    this.asked.push(call.name);
    this.calls.push(call);
    return this.verdict;
  }
}

const ALLOW: CallVerdict = {
  effect: DECISION_EFFECT.ALLOW,
  reason: 'permitted by policy',
};
const BLOCK: CallVerdict = {
  effect: DECISION_EFFECT.BLOCK,
  reason: 'writes to production',
};

interface Harness {
  session: FirewallSession;
  channel: RecordingChannel;
  authorizer: StubAuthorizer;
  logs: string[];
}

function harness(verdict: CallVerdict = ALLOW, filter = new ToolFilter()): Harness {
  const channel = new RecordingChannel();
  const authorizer = new StubAuthorizer(verdict);
  const logs: string[] = [];
  const session = new FirewallSession({
    filter,
    authorizer,
    channel,
    log: (message) => logs.push(message),
  });
  return { session, channel, authorizer, logs };
}

const line = (message: JsonRpcMessage): string => JSON.stringify(message);

const toolCall = (name: string, id: string | number = 1): string =>
  line({ jsonrpc: '2.0', id, method: 'tools/call', params: { name } });

describe('FirewallSession — pass-through traffic', () => {
  it('forwards a method that is neither tools/call nor tools/list', async () => {
    const { session, channel, authorizer } = harness();

    await session.fromClient(line({ jsonrpc: '2.0', id: 1, method: 'initialize' }));

    expect(channel.server).toHaveLength(1);
    expect(channel.client).toHaveLength(0);
    expect(authorizer.asked).toEqual([]);
  });

  it('forwards a non-JSON line to the server untouched', async () => {
    const { session, channel } = harness();

    await session.fromClient('not json at all');

    expect(channel.server).toEqual(['not json at all\n']);
  });

  it('passes a non-JSON server line back to the client untouched', () => {
    const { session, channel } = harness();

    session.fromServer('server noise');

    expect(channel.client).toEqual(['server noise\n']);
  });
});

describe('FirewallSession — gating tools/call', () => {
  it('forwards a call the authorizer allows', async () => {
    const { session, channel, authorizer } = harness(ALLOW);

    await session.fromClient(toolCall('read_file'));

    expect(authorizer.asked).toEqual(['read_file']);
    expect(channel.server).toHaveLength(1);
    expect(channel.client).toHaveLength(0);
  });

  it('answers the client directly when the call is blocked, and never forwards it', async () => {
    const { session, channel } = harness(BLOCK);

    await session.fromClient(toolCall('delete_repo', 7));

    expect(channel.server).toHaveLength(0);
    const reply = channel.lastToClient();
    expect(reply.id).toBe(7);
    expect(reply.result?.['isError']).toBe(true);
    expect(JSON.stringify(reply.result)).toContain(
      'Blocked by Memnox: writes to production',
    );
  });

  it('logs the block with the tool name and reason', async () => {
    const { session, logs } = harness(BLOCK);

    await session.fromClient(toolCall('delete_repo'));

    expect(logs).toEqual(['blocked tools/call "delete_repo": writes to production']);
  });

  it('blocks a statically filtered tool without consulting the authorizer', async () => {
    const { session, channel, authorizer } = harness(
      ALLOW,
      new ToolFilter(undefined, '^delete_'),
    );

    await session.fromClient(toolCall('delete_repo'));

    expect(authorizer.asked).toEqual([]);
    expect(channel.server).toHaveLength(0);
    expect(JSON.stringify(channel.lastToClient())).toContain(
      'denied by the static filter',
    );
  });

  it('treats a call with no tool name as an empty name rather than crashing', async () => {
    const { session, authorizer } = harness(ALLOW);

    await session.fromClient(line({ jsonrpc: '2.0', id: 1, method: 'tools/call' }));

    expect(authorizer.asked).toEqual(['']);
  });
});

describe('FirewallSession — filtering tools/list', () => {
  const listing = (id: number, ...names: string[]): string =>
    line({
      jsonrpc: '2.0',
      id,
      result: { tools: names.map((name) => ({ name })) },
    });

  async function requestListing(session: FirewallSession, id = 1): Promise<void> {
    await session.fromClient(line({ jsonrpc: '2.0', id, method: 'tools/list' }));
  }

  it('hides denied tools from the response', async () => {
    const { session, channel } = harness(ALLOW, new ToolFilter(undefined, '^delete_'));

    await requestListing(session);
    session.fromServer(listing(1, 'read_file', 'delete_repo', 'write_file'));

    const tools = channel.lastToClient().result?.['tools'] as Array<{ name: string }>;
    expect(tools.map((t) => t.name)).toEqual(['read_file', 'write_file']);
  });

  it('keeps every tool when no filter is configured', async () => {
    const { session, channel } = harness();

    await requestListing(session);
    session.fromServer(listing(1, 'read_file', 'delete_repo'));

    const tools = channel.lastToClient().result?.['tools'] as Array<{ name: string }>;
    expect(tools).toHaveLength(2);
  });

  it('leaves a response the proxy never asked for untouched', () => {
    const { session, channel } = harness(ALLOW, new ToolFilter(undefined, '^delete_'));

    session.fromServer(listing(99, 'delete_repo'));

    const tools = channel.lastToClient().result?.['tools'] as Array<{ name: string }>;
    expect(tools.map((t) => t.name)).toEqual(['delete_repo']);
  });

  it('only filters the first response for a given request id', async () => {
    const { session, channel } = harness(ALLOW, new ToolFilter(undefined, '^delete_'));

    await requestListing(session, 5);
    session.fromServer(listing(5, 'delete_repo'));
    session.fromServer(listing(5, 'delete_repo'));

    const second = channel.lastToClient().result?.['tools'] as Array<{ name: string }>;
    expect(second).toHaveLength(1);
  });

  it('leaves a result whose tools field is not an array alone', async () => {
    const { session, channel } = harness(ALLOW, new ToolFilter(undefined, '^delete_'));

    await requestListing(session);
    session.fromServer(line({ jsonrpc: '2.0', id: 1, result: { tools: 'unexpected' } }));

    expect(channel.lastToClient().result?.['tools']).toBe('unexpected');
  });
});

describe('FirewallSession — the wrapped server has exited', () => {
  it('answers the client instead of dropping an authorized call', async () => {
    const { session, channel } = harness(ALLOW);
    channel.accepting = false;

    await session.fromClient(toolCall('read_file', 3));

    expect(channel.server).toEqual([]);
    const reply = channel.lastToClient();
    expect(reply.id).toBe(3);
    expect(reply.result?.['isError']).toBe(true);
    expect(JSON.stringify(reply.result)).toContain('no longer running');
  });

  it('logs the drop with the method that was lost', async () => {
    const { session, channel, logs } = harness();
    channel.accepting = false;

    await session.fromClient(line({ jsonrpc: '2.0', id: 1, method: 'initialize' }));

    expect(logs[0]).toContain('not accepting input');
    expect(logs[0]).toContain('initialize');
  });

  it('stays quiet toward the client for a notification, which expects no reply', async () => {
    const { session, channel, logs } = harness();
    channel.accepting = false;

    await session.fromClient(line({ jsonrpc: '2.0', method: 'notifications/cancelled' }));

    expect(channel.client).toEqual([]);
    expect(logs).toHaveLength(1);
  });

  it('logs a dropped raw line rather than losing it silently', async () => {
    const { session, channel, logs } = harness();
    channel.accepting = false;

    await session.fromClient('not json at all');

    expect(channel.client).toEqual([]);
    expect(logs[0]).toContain('raw line');
  });
});

describe('UngovernedAuthorizer', () => {
  it('allows every call so static filters remain the only gate', async () => {
    expect(await new UngovernedAuthorizer().authorize()).toEqual({
      effect: DECISION_EFFECT.ALLOW,
      reason: 'no runtime configured',
    });
  });
});
