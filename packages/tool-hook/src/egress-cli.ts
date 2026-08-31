import { connect } from 'node:net';
import { createServer, request as httpRequest, type IncomingMessage } from 'node:http';
import type { ServerResponse, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { EgressSeam, EGRESS_BLIND_SPOTS } from './egress-seam';
import { buildAuthorizer, log } from './seam-runtime';
import { EGRESS_DEFAULT_PORT, EGRESS_MAX_BODY_BYTES } from './tool-hook.constants';

const REFUSED_STATUS = 403;
const TUNNEL_OK = 'HTTP/1.1 200 Connection Established\r\n\r\n';

const USAGE = `Usage: memnox-egress [--port <port>]

An HTTP forward proxy that rules on what leaves this machine. Point an agent at it:

  HTTP_PROXY=http://127.0.0.1:${EGRESS_DEFAULT_PORT} HTTPS_PROXY=http://127.0.0.1:${EGRESS_DEFAULT_PORT} <your agent>

Blind to:
${EGRESS_BLIND_SPOTS.map((spot) => `  ${spot}`).join('\n')}`;

function portFrom(argv: readonly string[]): number | null {
  const index = argv.indexOf('--port');
  if (index === -1) return EGRESS_DEFAULT_PORT;
  const raw = argv[index + 1];
  if (raw === undefined) return null;
  const port = Number(raw);
  return Number.isInteger(port) && port > 0 && port < 65_536 ? port : null;
}

/** Bounded: a body this seam cannot hold is one it must not pretend to have read. */
async function readBody(message: IncomingMessage): Promise<string | undefined> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of message) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > EGRESS_MAX_BODY_BYTES) return undefined;
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function refuse(response: ServerResponse, message: string): void {
  response.writeHead(REFUSED_STATUS, { 'content-type': 'text/plain' });
  // The reason reaches whatever made the call, or the refusal is a dead end.
  response.end(`Memnox withheld this request.\n${message}\n`);
}

function buildServer(seam: EgressSeam): Server {
  const server = createServer((request, response) => {
    void (async () => {
      const url = request.url;
      const method = request.method;
      if (url === undefined || method === undefined)
        return refuse(response, 'no request');

      const body = await readBody(request);
      const outcome = await seam.gateRequest({
        method,
        url,
        headers: headersOf(request),
        // Undefined means it was larger than this seam reads, not that it was empty.
        ...(body === undefined ? {} : { body }),
      });

      if (!outcome.allowed) {
        log(`withheld ${method} ${url}: ${outcome.message ?? ''}`);
        return refuse(response, outcome.message ?? 'no reason recorded');
      }
      forward(request, response, url, method, body);
    })();
  });

  server.on('connect', (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    void (async () => {
      const authority = request.url;
      if (authority === undefined) return socket.destroy();

      const outcome = await seam.gateConnect(authority);
      if (!outcome.allowed) {
        log(`withheld CONNECT ${authority}: ${outcome.message ?? ''}`);
        socket.end(
          `HTTP/1.1 ${REFUSED_STATUS} Forbidden\r\n\r\n${outcome.message ?? ''}`,
        );
        return;
      }
      tunnel(authority, socket, head);
    })();
  });

  return server;
}

function headersOf(request: IncomingMessage): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(request.headers)) {
    if (typeof value === 'string') headers[name] = value;
  }
  return headers;
}

/** Forwarded unchanged: this seam rules on a request, it never rewrites one. */
function forward(
  request: IncomingMessage,
  response: ServerResponse,
  url: string,
  method: string,
  body: string | undefined,
): void {
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
      headers: request.headers,
    },
    (answer) => {
      response.writeHead(answer.statusCode ?? 502, answer.headers);
      answer.pipe(response);
    },
  );
  upstream.on('error', (err: unknown) => {
    log(`upstream failed for ${url}: ${String(err)}`);
    response.writeHead(502).end();
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

  const upstream = connect(Number(rawPort ?? '443'), host, () => {
    socket.write(TUNNEL_OK);
    upstream.write(head);
    upstream.pipe(socket);
    socket.pipe(upstream);
  });
  upstream.on('error', () => socket.destroy());
  socket.on('error', () => upstream.destroy());
}

async function main(): Promise<void> {
  const port = portFrom(process.argv.slice(2));
  if (port === null) {
    process.stderr.write(`${USAGE}\n`);
    process.exitCode = 1;
    return;
  }

  const seam = new EgressSeam({ authorizer: await buildAuthorizer() });
  buildServer(seam).listen(port, '127.0.0.1', () => {
    log(`egress seam on 127.0.0.1:${port}`);
    // A blind spot nobody reads is a blind spot nobody has.
    for (const spot of EGRESS_BLIND_SPOTS) log(`blind to: ${spot}`);
  });
}

main().catch((err: unknown) => {
  log(`egress seam failed to start, ruling on nothing: ${String(err)}`);
  process.exitCode = 1;
});
