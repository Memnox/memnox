import { describe, expect, it } from 'vitest';
import { DECISION_EFFECT } from '@memnox/core';
import {
  GatewayExchange,
  ToolFilter,
  type CallAuthorizer,
  type CallVerdict,
  type JsonRpcMessage,
  type ToolCall,
  type UpstreamServer,
} from '../src/index';

/** Stands in for the MCP server this gateway fronts. */
class RecordingUpstream implements UpstreamServer {
  readonly received: string[] = [];
  readonly sessions: Array<string | undefined> = [];

  constructor(private readonly replies: (payload: string) => string[]) {}

  async send(payload: string, sessionId?: string): Promise<string[]> {
    this.received.push(payload);
    this.sessions.push(sessionId);
    return this.replies(payload);
  }
}

class StubAuthorizer implements CallAuthorizer {
  readonly asked: string[] = [];

  constructor(private readonly verdict: CallVerdict) {}

  async authorize(call: ToolCall): Promise<CallVerdict> {
    this.asked.push(call.name);
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

const ECHO_RESULT = (payload: string): string[] => {
  const message = JSON.parse(payload) as JsonRpcMessage;
  return [JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { ok: true } })];
};

interface Harness {
  exchange: GatewayExchange;
  upstream: RecordingUpstream;
  authorizer: StubAuthorizer;
  logs: string[];
}

function harness(
  verdict: CallVerdict = ALLOW,
  replies: (payload: string) => string[] = ECHO_RESULT,
  filter = new ToolFilter(),
  sessionId?: string,
): Harness {
  const upstream = new RecordingUpstream(replies);
  const authorizer = new StubAuthorizer(verdict);
  const logs: string[] = [];
  const exchange = new GatewayExchange({
    filter,
    authorizer,
    upstream,
    sessionId,
    log: (message) => logs.push(message),
  });
  return { exchange, upstream, authorizer, logs };
}

const toolCall = (name: string, id: number | string = 1): string =>
  JSON.stringify({
    jsonrpc: '2.0',
    id,
    method: 'tools/call',
    params: { name, arguments: {} },
  });

describe('GatewayExchange gates a POSTed tools/call', () => {
  it('forwards an allowed call and returns the server reply', async () => {
    const h = harness();

    const result = await h.exchange.handle(toolCall('read_file'));

    expect(h.authorizer.asked).toEqual(['read_file']);
    expect(h.upstream.received).toHaveLength(1);
    expect(result).toMatchObject({ malformed: false });
    if (result.malformed) throw new Error('unreachable');
    expect(result.replies[0]?.result).toEqual({ ok: true });
  });

  // The whole point of a remote gateway: the server is never reached.
  it('never reaches the server when policy blocks the call', async () => {
    const h = harness(BLOCK);

    const result = await h.exchange.handle(toolCall('delete_database'));

    expect(h.upstream.received).toEqual([]);
    if (result.malformed) throw new Error('unreachable');
    expect(result.replies[0]?.result).toMatchObject({ isError: true });
    expect(JSON.stringify(result.replies[0])).toContain('writes to production');
  });

  it('answers the blocked call on its own id, so the client is not left waiting', async () => {
    const h = harness(BLOCK);

    const result = await h.exchange.handle(toolCall('delete_database', 'abc'));

    if (result.malformed) throw new Error('unreachable');
    expect(result.replies[0]?.id).toBe('abc');
  });

  it('filters tools/list on the way back, so denied tools are never advertised', async () => {
    const listing = (payload: string): string[] => {
      const message = JSON.parse(payload) as JsonRpcMessage;
      return [
        JSON.stringify({
          jsonrpc: '2.0',
          id: message.id,
          result: { tools: [{ name: 'read_file' }, { name: 'drop_table' }] },
        }),
      ];
    };
    const h = harness(ALLOW, listing, new ToolFilter(undefined, 'drop_'));

    const result = await h.exchange.handle(
      JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/list' }),
    );

    if (result.malformed) throw new Error('unreachable');
    const tools = result.replies[0]?.result?.['tools'];
    expect(tools).toEqual([{ name: 'read_file' }]);
  });

  it('blocks a statically denied tool without asking the runtime', async () => {
    const h = harness(ALLOW, ECHO_RESULT, new ToolFilter(undefined, 'drop_'));

    const result = await h.exchange.handle(toolCall('drop_table'));

    expect(h.authorizer.asked).toEqual([]);
    expect(h.upstream.received).toEqual([]);
    if (result.malformed) throw new Error('unreachable');
    expect(result.replies[0]?.result).toMatchObject({ isError: true });
  });

  it('passes a method that is not a tool call straight through', async () => {
    const h = harness();

    await h.exchange.handle(
      JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'initialize' }),
    );

    expect(h.authorizer.asked).toEqual([]);
    expect(h.upstream.received).toHaveLength(1);
  });

  it('returns nothing for a notification, which expects no answer', async () => {
    const h = harness(ALLOW, () => []);

    const result = await h.exchange.handle(
      JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    );

    if (result.malformed) throw new Error('unreachable');
    expect(result.replies).toEqual([]);
  });

  it('gates every entry of a batch', async () => {
    const h = harness(BLOCK);

    const result = await h.exchange.handle(`[${toolCall('a', 1)},${toolCall('b', 2)}]`);

    expect(h.upstream.received).toEqual([]);
    if (result.malformed) throw new Error('unreachable');
    expect(result.replies).toHaveLength(2);
  });

  it('reports a body that is not JSON rather than forwarding it', async () => {
    const h = harness();

    expect(await h.exchange.handle('not json at all')).toEqual({
      malformed: true,
    });
    expect(h.upstream.received).toEqual([]);
  });

  it('carries the session id upstream so calls group in the audit timeline', async () => {
    const h = harness(ALLOW, ECHO_RESULT, new ToolFilter(), 'sess-9');

    await h.exchange.handle(toolCall('read_file'));

    expect(h.upstream.sessions).toEqual(['sess-9']);
  });

  it('reads a reply the server sent as an event stream', async () => {
    const asEventStream = (payload: string): string[] => {
      const message = JSON.parse(payload) as JsonRpcMessage;
      // What HttpUpstreamServer hands back once it has unwrapped `data:` lines.
      return [
        JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { streamed: true } }),
      ];
    };
    const h = harness(ALLOW, asEventStream);

    const result = await h.exchange.handle(toolCall('read_file'));

    if (result.malformed) throw new Error('unreachable');
    expect(result.replies[0]?.result).toEqual({ streamed: true });
  });
});
