import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { McpGateway, type UpstreamServer } from '../src/index';

// Assembled at runtime so no credential-shaped literal sits in this file.
const AGENT_TOKEN = ['mnx', 'gateway', 'token'].join('_');
const OTHER_TOKEN = ['mnx', 'other', 'agent'].join('_');

class StubUpstream implements UpstreamServer {
  readonly received: string[] = [];
  readonly sessions: Array<string | undefined> = [];

  async send(payload: string, sessionId?: string): Promise<string[]> {
    this.received.push(payload);
    this.sessions.push(sessionId);
    const message = JSON.parse(payload) as { id?: unknown };
    // A notification gets a 202 upstream, which carries no payload back.
    if (message.id === undefined) return [];
    return [JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { ok: true } })];
  }
}

interface RuntimeCall {
  authorization: string | undefined;
  body: Record<string, unknown>;
}

/** Stands in for the Memnox runtime the gateway checks every call against. */
interface FakeRuntime {
  url: string;
  calls: RuntimeCall[];
  server: Server;
}

const ALLOW_DECISION = {
  eventId: 'evt-1',
  effect: 'allow',
  riskLevel: 'low',
  reason: 'policy: mcp reads are permitted',
  matchedPolicies: [],
  advisories: [],
};

const BLOCK_DECISION = {
  ...ALLOW_DECISION,
  effect: 'withhold',
  reason: 'policy: production writes are withheld',
};

function startRuntime(decision: Record<string, unknown>): Promise<FakeRuntime> {
  const calls: RuntimeCall[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      calls.push({
        authorization: request.headers['authorization'],
        body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<
          string,
          unknown
        >,
      });
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(decision));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        throw new Error('runtime did not bind');
      }
      resolve({ url: `http://127.0.0.1:${address.port}`, calls, server });
    });
  });
}

interface Running {
  url: string;
  gateway: McpGateway;
  upstream: StubUpstream;
}

const running: Running[] = [];
const runtimes: FakeRuntime[] = [];

/** Nothing listens on port 9, so a call to it is a runtime that cannot be reached. */
const UNREACHABLE_RUNTIME = 'http://127.0.0.1:9';

/** Binds port 0 so suites never collide on a fixed port. */
async function start(
  options: { runtimeUrl?: string; failOpen?: boolean } = {},
): Promise<Running> {
  const upstream = new StubUpstream();
  const gateway = new McpGateway({
    upstream,
    serverName: 'github',
    runtimeUrl: options.runtimeUrl ?? UNREACHABLE_RUNTIME,
    host: '127.0.0.1',
    port: 0,
    failOpen: options.failOpen,
    log: () => {},
  });
  await gateway.listen();
  const address = gateway.address();
  if (address === null) throw new Error('gateway did not bind');
  const started = {
    url: `http://127.0.0.1:${address.port}/mcp`,
    gateway,
    upstream,
  };
  running.push(started);
  return started;
}

/** A gateway wired to a runtime that answers every check with `decision`. */
async function startGoverned(
  decision: Record<string, unknown>,
): Promise<Running & { runtime: FakeRuntime }> {
  const runtime = await startRuntime(decision);
  runtimes.push(runtime);
  return { ...(await start({ runtimeUrl: runtime.url })), runtime };
}

afterEach(async () => {
  while (running.length > 0) {
    const entry = running.pop();
    if (entry !== undefined) await entry.gateway.close();
  }
  while (runtimes.length > 0) {
    const entry = runtimes.pop();
    if (entry !== undefined) {
      await new Promise<void>((resolve) => entry.server.close(() => resolve()));
    }
  }
});

const post = (url: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

const authorized = { authorization: `Bearer ${AGENT_TOKEN}` };

const TOOL_CALL = {
  jsonrpc: '2.0',
  id: 1,
  method: 'tools/call',
  params: { name: 'read_file', arguments: {} },
};

describe('McpGateway authenticates the caller', () => {
  // Fail closed on identity: an anonymous caller would make the whole fleet
  // look like one agent in the audit trail.
  it('refuses a call with no agent token', async () => {
    const { url, upstream } = await start();

    const response = await post(url, TOOL_CALL);

    expect(response.status).toBe(401);
    expect(upstream.received).toEqual([]);
  });

  it('refuses an Authorization header that is not a bearer token', async () => {
    const { url } = await start();

    const response = await post(url, TOOL_CALL, { authorization: 'Basic abc' });

    expect(response.status).toBe(401);
  });

  it('refuses a bearer header with nothing after it', async () => {
    const { url } = await start();

    const response = await post(url, TOOL_CALL, { authorization: 'Bearer    ' });

    expect(response.status).toBe(401);
  });

  // The point of a per-request token: the runtime sees the agent that called,
  // not the process that proxied.
  it('checks each call under the token its caller presented', async () => {
    const { url, runtime } = await startGoverned(ALLOW_DECISION);

    await post(url, TOOL_CALL, authorized);
    await post(url, TOOL_CALL, { authorization: `Bearer ${OTHER_TOKEN}` });

    expect(runtime.calls.map((call) => call.authorization)).toEqual([
      `Bearer ${AGENT_TOKEN}`,
      `Bearer ${OTHER_TOKEN}`,
    ]);
  });
});

describe('McpGateway gates a call against the runtime', () => {
  it('forwards an allowed call and returns the server reply', async () => {
    const { url, upstream, runtime } = await startGoverned(ALLOW_DECISION);

    const response = await post(url, TOOL_CALL, authorized);

    expect(response.status).toBe(200);
    expect(upstream.received).toHaveLength(1);
    expect(await response.json()).toMatchObject({ id: 1, result: { ok: true } });
    expect(runtime.calls[0]?.body).toMatchObject({
      action: 'mcp.read_file',
      target: 'github',
    });
  });

  it('never reaches the server when policy withholds the call', async () => {
    const { url, upstream } = await startGoverned(BLOCK_DECISION);

    const response = await post(url, TOOL_CALL, authorized);

    expect(response.status).toBe(200);
    expect(upstream.received).toEqual([]);
    expect(JSON.stringify(await response.json())).toContain('production writes');
  });

  // The runtime is unreachable here, and the firewall fails closed, so an
  // authenticated call is still refused rather than forwarded.
  it('does not reach the server when the runtime cannot be asked', async () => {
    const { url, upstream } = await start();

    const response = await post(url, TOOL_CALL, authorized);

    expect(response.status).toBe(200);
    expect(upstream.received).toEqual([]);
    expect(JSON.stringify(await response.json())).toContain('failing closed');
  });

  it('forwards despite an unreachable runtime once fail-open is chosen', async () => {
    const { url, upstream } = await start({ failOpen: true });

    const response = await post(url, TOOL_CALL, authorized);

    expect(response.status).toBe(200);
    expect(upstream.received).toHaveLength(1);
    expect(await response.json()).toMatchObject({ result: { ok: true } });
  });

  it('carries the session id to both the runtime and the server', async () => {
    const { url, upstream, runtime } = await startGoverned(ALLOW_DECISION);

    await post(url, TOOL_CALL, { ...authorized, 'mcp-session-id': 'sess-3' });

    expect(runtime.calls[0]?.body['sessionId']).toBe('sess-3');
    expect(upstream.sessions).toEqual(['sess-3']);
  });
});

describe('McpGateway answers the HTTP request', () => {
  it('202s a notification, which expects no reply', async () => {
    const { url, upstream } = await startGoverned(ALLOW_DECISION);

    const response = await post(
      url,
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      authorized,
    );

    expect(response.status).toBe(202);
    expect(await response.text()).toBe('');
    expect(upstream.received).toHaveLength(1);
  });

  it('answers a batch with an array of replies', async () => {
    const { url } = await startGoverned(ALLOW_DECISION);

    const response = await post(url, [TOOL_CALL, { ...TOOL_CALL, id: 2 }], authorized);

    expect(response.status).toBe(200);
    const replies = (await response.json()) as Array<{ id: number }>;
    expect(replies.map((reply) => reply.id)).toEqual([1, 2]);
  });

  it('serves its path with a query string attached', async () => {
    const { url, upstream } = await startGoverned(ALLOW_DECISION);

    const response = await post(`${url}?client=cursor`, TOOL_CALL, authorized);

    expect(response.status).toBe(200);
    expect(upstream.received).toHaveLength(1);
  });

  it('404s a path it does not serve', async () => {
    const { url } = await start();

    const response = await post(url.replace('/mcp', '/nope'), TOOL_CALL, authorized);

    expect(response.status).toBe(404);
  });

  it('405s a GET, rather than accepting a stream it never feeds', async () => {
    const { url } = await start();

    const response = await fetch(url, { headers: authorized });

    expect(response.status).toBe(405);
  });

  it('400s a body that is not JSON-RPC', async () => {
    const { url } = await start();

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authorized },
      body: 'not json',
    });

    expect(response.status).toBe(400);
  });

  it('400s an empty body', async () => {
    const { url } = await start();

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authorized },
      body: '',
    });

    expect(response.status).toBe(400);
  });

  // The cap is enforced while reading, so the caller sees a transport failure.
  it('cuts off a body past the size cap without forwarding it', async () => {
    const { url, upstream } = await startGoverned(ALLOW_DECISION);
    const oversized = JSON.stringify({
      ...TOOL_CALL,
      params: { name: 'read_file', arguments: { blob: 'a'.repeat(5 * 1024 * 1024) } },
    });

    await expect(
      fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...authorized },
        body: oversized,
      }),
    ).rejects.toThrow();
    expect(upstream.received).toEqual([]);
  });
});

describe('McpGateway owns its socket', () => {
  it('reports no address before it listens', () => {
    const gateway = new McpGateway({
      upstream: new StubUpstream(),
      serverName: 'github',
      runtimeUrl: UNREACHABLE_RUNTIME,
      log: () => {},
    });

    expect(gateway.address()).toBeNull();
  });

  it('closes cleanly even if it never listened', async () => {
    const gateway = new McpGateway({
      upstream: new StubUpstream(),
      serverName: 'github',
      runtimeUrl: UNREACHABLE_RUNTIME,
      log: () => {},
    });

    await expect(gateway.close()).resolves.toBeUndefined();
  });

  it('stops answering once closed', async () => {
    const { url, gateway } = await start();

    await gateway.close();

    await expect(post(url, TOOL_CALL, authorized)).rejects.toThrow();
  });
});
