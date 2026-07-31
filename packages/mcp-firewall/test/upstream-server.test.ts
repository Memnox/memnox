import { describe, expect, it } from 'vitest';
import { HttpUpstreamServer } from '../src/index';

const UPSTREAM_URL = 'http://server.test/mcp';

interface Sent {
  url: string;
  method: string | undefined;
  headers: Record<string, string>;
  body: unknown;
}

interface Harness {
  upstream: HttpUpstreamServer;
  sent: Sent[];
}

function harness(
  reply: () => Response,
  options: { authorization?: string } = {},
): Harness {
  const sent: Sent[] = [];
  const upstream = new HttpUpstreamServer({
    url: UPSTREAM_URL,
    ...options,
    fetchImpl: async (input, init) => {
      sent.push({
        url: String(input),
        method: init === undefined ? undefined : init.method,
        headers: (init === undefined ? {} : init.headers) as Record<string, string>,
        body: init === undefined ? undefined : init.body,
      });
      return reply();
    },
  });
  return { upstream, sent };
}

const json = (body: string, status = 200): Response =>
  new Response(body, { status, headers: { 'content-type': 'application/json' } });

const REPLY = '{"jsonrpc":"2.0","id":1,"result":{"ok":true}}';

describe('HttpUpstreamServer posts to the fronted server', () => {
  it('POSTs the payload verbatim to the configured url', async () => {
    const h = harness(() => json(REPLY));

    await h.upstream.send('{"jsonrpc":"2.0","id":1}');

    expect(h.sent[0]?.url).toBe(UPSTREAM_URL);
    expect(h.sent[0]?.method).toBe('POST');
    expect(h.sent[0]?.body).toBe('{"jsonrpc":"2.0","id":1}');
    expect(h.sent[0]?.headers['content-type']).toBe('application/json');
  });

  // A Streamable HTTP server picks its response shape from Accept; both are handled.
  it('accepts either a JSON object or an event stream in reply', async () => {
    const h = harness(() => json(REPLY));

    await h.upstream.send('{}');

    expect(h.sent[0]?.headers['accept']).toBe('application/json, text/event-stream');
  });

  it('forwards the session id so the server can correlate a client', async () => {
    const h = harness(() => json(REPLY));

    await h.upstream.send('{}', 'sess-4');

    expect(h.sent[0]?.headers['mcp-session-id']).toBe('sess-4');
  });

  it('omits the session header when there is no session', async () => {
    const h = harness(() => json(REPLY));

    await h.upstream.send('{}');

    expect(h.sent[0]?.headers['mcp-session-id']).toBeUndefined();
  });

  // The caller's Memnox credential authenticates them to Memnox; forwarding it
  // to a third-party server would hand that server an agent's identity.
  it('sends only the configured upstream credential', async () => {
    const h = harness(() => json(REPLY), { authorization: 'Bearer upstream-only' });

    await h.upstream.send('{}');

    expect(h.sent[0]?.headers['authorization']).toBe('Bearer upstream-only');
  });

  it('sends no credential at all when none is configured', async () => {
    const h = harness(() => json(REPLY));

    await h.upstream.send('{}');

    expect(h.sent[0]?.headers['authorization']).toBeUndefined();
  });
});

describe('HttpUpstreamServer reads what came back', () => {
  it('returns a JSON reply as a single payload', async () => {
    const h = harness(() => json(REPLY));

    expect(await h.upstream.send('{}')).toEqual([REPLY]);
  });

  it('unwraps a reply the server sent as an event stream', async () => {
    const h = harness(
      () =>
        new Response('event: message\ndata: {"jsonrpc":"2.0","id":1}\n\n', {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        }),
    );

    expect(await h.upstream.send('{}')).toEqual(['{"jsonrpc":"2.0","id":1}']);
  });

  it('reads an event stream whose content type carries a charset', async () => {
    const h = harness(
      () =>
        new Response('data: {"jsonrpc":"2.0","id":1}\n\n', {
          status: 200,
          headers: { 'content-type': 'text/event-stream; charset=utf-8' },
        }),
    );

    expect(await h.upstream.send('{}')).toEqual(['{"jsonrpc":"2.0","id":1}']);
  });

  it('splits a stream that carried several messages', async () => {
    const h = harness(
      () =>
        new Response('data: {"id":1}\n\ndata: {"id":2}\n\n', {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        }),
    );

    expect(await h.upstream.send('{}')).toEqual(['{"id":1}', '{"id":2}']);
  });

  it('returns nothing for the 202 a notification gets', async () => {
    const h = harness(() => new Response(null, { status: 202 }));

    expect(await h.upstream.send('{}')).toEqual([]);
  });

  it('returns nothing for an empty body, rather than an unparsable payload', async () => {
    const h = harness(() => json('   '));

    expect(await h.upstream.send('{}')).toEqual([]);
  });

  // A JSON-RPC error is still a reply the waiting client must receive.
  it('passes a JSON-RPC error body back to the caller', async () => {
    const error = '{"jsonrpc":"2.0","id":1,"error":{"code":-32602,"message":"bad"}}';
    const h = harness(() => json(error, 400));

    expect(await h.upstream.send('{}')).toEqual([error]);
  });
});
