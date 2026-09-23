/**
 * The egress proxy as a server anything can hold: `memnox-egress`, the daemon, and a
 * `memnox run` whose session needs its own. Loopback only, bounded in connections and
 * idle time, and it never rewrites a payload. What it cannot see is declared beside it.
 */
import { connect } from 'node:net';
import { createServer, request as httpRequest, type IncomingMessage } from 'node:http';
import type { ServerResponse, Server } from 'node:http';
import type { Duplex } from 'node:stream';

import {
  ACTOR_TYPE,
  ENFORCEMENT_MODE,
  EVENT_SCHEMA_VERSION,
  EVENT_SURFACE,
  HTTP,
  MINUTE_MS,
  newEventId,
  TOOL_CLASS,
  UNNAMED_AGENT,
  UNNAMED_SESSION,
  DECISION_EFFECT,
  type DestinationRecords,
  type EventSink,
  type MemnoxEvent,
} from '@memnox/core';

import {
  destinationOf,
  type EgressCaller,
  type EgressRuling,
  type EgressSeam,
  type HttpAttempt,
} from './egress-seam';
import { EGRESS_MAX_BODY_BYTES } from './tool-hook.constants';

/** Loopback only: a proxy reachable from the network is a hole, not a seam. */
export const EGRESS_LOOPBACK = '127.0.0.1';

/** The most connections held at once; past it a client waits for the kernel's backlog. */
export const EGRESS_MAX_CONNECTIONS = 256;

/** A tunnel or request idle this long is closed, so a hung client never holds a slot. */
export const EGRESS_IDLE_MS = 2 * MINUTE_MS;

/** The port a CONNECT authority implies when it names none. */
const HTTPS_PORT = '443';

const TUNNEL_OK = 'HTTP/1.1 200 Connection Established\r\n\r\n';

const PROXY_AUTHORIZATION = 'proxy-authorization';

export interface EgressProxyOptions {
  seam: EgressSeam;
  /** Zero asks the kernel for a free one. */
  port: number;
  log: (message: string) => void;
}

/** A running proxy: where it listens, and how it is stopped with everything it holds. */
export interface EgressProxy {
  port: number;
  close: () => Promise<void>;
}

/** Listens on loopback. Rejects when the port is taken, so the caller can pick another. */
export async function startEgressProxy(
  options: EgressProxyOptions,
): Promise<EgressProxy> {
  const open = new Set<Duplex>();
  const server = buildServer(options, open);
  server.maxConnections = EGRESS_MAX_CONNECTIONS;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, EGRESS_LOOPBACK, () => resolve());
  });
  const address = server.address();
  const port =
    typeof address === 'object' && address !== null ? address.port : options.port;
  return {
    port,
    close: () =>
      new Promise<void>((resolve) => {
        // A tunnel never ends on its own, so closing waits on nothing that is still open.
        for (const socket of open) socket.destroy();
        server.close(() => resolve());
      }),
  };
}

/** The proxy URL a client is given: the caller rides as its credentials, never as a secret. */
export function proxyUrlFor(port: number, caller: EgressCaller = {}): string {
  const user = caller.sessionId === undefined ? '' : encodeURIComponent(caller.sessionId);
  const pass = caller.agent === undefined ? '' : `:${encodeURIComponent(caller.agent)}`;
  const auth = user === '' && pass === '' ? '' : `${user}${pass}@`;
  return `http://${auth}${EGRESS_LOOPBACK}:${port}`;
}

/** Who a request came from, read off the credentials `proxyUrlFor` put in its URL. */
export function callerOf(headers: IncomingMessage['headers']): EgressCaller {
  const header = headers[PROXY_AUTHORIZATION];
  if (typeof header !== 'string' || !header.startsWith('Basic ')) return {};
  const decoded = Buffer.from(header.slice('Basic '.length), 'base64').toString('utf8');
  const colon = decoded.indexOf(':');
  const user = colon === -1 ? decoded : decoded.slice(0, colon);
  const pass = colon === -1 ? '' : decoded.slice(colon + 1);
  return {
    ...(user === '' ? {} : { sessionId: decodeURIComponent(user) }),
    ...(pass === '' ? {} : { agent: decodeURIComponent(pass) }),
  };
}

/** The ledger row for one ruling: the host only, since a path or a query can carry a secret. */
export function egressEventFor(ruling: EgressRuling, at: string): MemnoxEvent {
  return {
    id: newEventId(),
    schemaVersion: EVENT_SCHEMA_VERSION,
    at,
    sessionId: ruling.caller.sessionId ?? UNNAMED_SESSION,
    agent: ruling.caller.agent ?? UNNAMED_AGENT,
    actorType: ACTOR_TYPE.AGENT,
    surface: EVENT_SURFACE.NETWORK,
    operation: ruling.action,
    target: destinationOf(ruling.target),
    class: TOOL_CLASS.UNKNOWN,
    effect: ruling.effect,
    mode: ENFORCEMENT_MODE.ENFORCE,
    reason: ruling.reason,
  };
}

/**
 * What a proxy does with each ruling: a ledger row, and for a reached host an entry in
 * the agent's destination record. Best effort, because a ledger that stops a request is
 * a proxy somebody unsets.
 */
export function recordEgress(
  ledger: EventSink | null,
  destinations: DestinationRecords,
  now: () => Date = () => new Date(),
): (ruling: EgressRuling) => Promise<void> {
  return async (ruling) => {
    const at = now().toISOString();
    const row = egressEventFor(ruling, at);
    await ledger?.append(row).catch(() => undefined);
    const agent = ruling.caller.agent;
    if (agent === undefined || ruling.effect !== DECISION_EFFECT.ALLOW) return;
    await destinations
      .record(agent, destinationOf(ruling.target), at)
      .catch(() => undefined);
  };
}

function buildServer(options: EgressProxyOptions, open: Set<Duplex>): Server {
  const server = createServer((request, response) => {
    void answerRequest(options, request, response);
  });
  server.on('connection', (socket) => {
    open.add(socket);
    socket.setTimeout(EGRESS_IDLE_MS, () => socket.destroy());
    socket.on('close', () => open.delete(socket));
  });
  server.on('connect', (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    void answerConnect(options, { request, socket, head });
  });
  return server;
}

/** Bounded: a body this seam cannot hold is one it must not pretend to have read. */
async function readBody(message: IncomingMessage): Promise<string | undefined> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of message) {
    // A request with no encoding set yields Buffers, never strings.
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > EGRESS_MAX_BODY_BYTES) return undefined;
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function refuse(response: ServerResponse, message: string): void {
  response.writeHead(HTTP.FORBIDDEN, { 'content-type': 'text/plain' });
  // The reason reaches whatever made the call, or the refusal is a dead end.
  response.end(`Memnox denied this request.\n${message}\n`);
}

async function answerRequest(
  options: EgressProxyOptions,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const url = request.url;
  const method = request.method;
  if (url === undefined || method === undefined) return refuse(response, 'no request');

  const body = await readBody(request);
  const attempt: HttpAttempt = {
    method,
    url,
    headers: headersOf(request),
    // Undefined means it was larger than this seam reads, not that it was empty.
    ...(body === undefined ? {} : { body }),
  };
  const outcome = await options.seam.gateRequest(attempt, callerOf(request.headers));
  if (!outcome.allowed) {
    options.log(`denied ${method} ${destinationOf(url)}: ${outcome.message ?? ''}`);
    return refuse(response, outcome.message ?? 'no reason recorded');
  }
  forward(response, attempt);
}

/** A CONNECT the client asked for: the request, and the socket and bytes already read. */
interface TunnelRequest {
  request: IncomingMessage;
  socket: Duplex;
  head: Buffer;
}

async function answerConnect(
  options: EgressProxyOptions,
  tunnelRequest: TunnelRequest,
): Promise<void> {
  const { request, socket, head } = tunnelRequest;
  const authority = request.url;
  if (authority === undefined) {
    socket.destroy();
    return;
  }
  const outcome = await options.seam.gateConnect(authority, callerOf(request.headers));
  if (!outcome.allowed) {
    options.log(`denied CONNECT ${authority}: ${outcome.message ?? ''}`);
    socket.end(`HTTP/1.1 ${HTTP.FORBIDDEN} Forbidden\r\n\r\n${outcome.message ?? ''}`);
    return;
  }
  tunnel(authority, socket, head);
}

/** Addressed to this proxy, so neither ruled on as a payload nor passed upstream. */
function headersOf(request: IncomingMessage): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(request.headers)) {
    if (typeof value === 'string' && name !== PROXY_AUTHORIZATION) headers[name] = value;
  }
  return headers;
}

/** Forwarded unchanged: this seam rules on a request, it never rewrites one. */
function forward(response: ServerResponse, attempt: HttpAttempt): void {
  const { url, method, body } = attempt;
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return refuse(response, 'this proxy takes absolute-form requests only');
  }

  const upstream = httpRequest(
    {
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port,
      path: `${target.pathname}${target.search}`,
      method,
      headers: attempt.headers ?? {},
    },
    (answer) => {
      response.writeHead(answer.statusCode ?? HTTP.BAD_GATEWAY, answer.headers);
      answer.pipe(response);
    },
  );
  upstream.on('error', () => {
    response.writeHead(HTTP.BAD_GATEWAY).end();
  });
  if (body !== undefined) upstream.write(body);
  upstream.end();
}

/** Bytes only. What travels inside is the blind spot this seam declares. */
function tunnel(authority: string, socket: Duplex, head: Buffer): void {
  const [host, rawPort] = authority.split(':');
  if (host === undefined) {
    socket.destroy();
    return;
  }

  const upstream = connect(Number(rawPort ?? HTTPS_PORT), host, () => {
    socket.write(TUNNEL_OK);
    upstream.write(head);
    upstream.pipe(socket);
    socket.pipe(upstream);
  });
  upstream.setTimeout(EGRESS_IDLE_MS, () => upstream.destroy());
  upstream.on('error', () => socket.destroy());
  upstream.on('close', () => socket.destroy());
  socket.on('error', () => upstream.destroy());
  socket.on('close', () => upstream.destroy());
}
