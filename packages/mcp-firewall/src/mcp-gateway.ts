import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import type { LocalGate } from '@memnox/local-gate';
import { MemnoxClient } from '@memnox/sdk';
import {
  LayeredAuthorizer,
  LocalGateAuthorizer,
  RuntimeAuthorizer,
  type CallAuthorizer,
} from './call-authorizer';
import { GatewayExchange } from './gateway-exchange';
import {
  BEARER_PREFIX,
  CONTENT_TYPE_JSON,
  DEFAULT_GATEWAY_HOST,
  DEFAULT_GATEWAY_PATH,
  DEFAULT_GATEWAY_PORT,
  HEADER_AUTHORIZATION,
  HEADER_CONTENT_TYPE,
  HEADER_MCP_SESSION,
  MAX_BODY_BYTES,
} from './gateway.constants';
import { ToolFilter } from './tool-filter';
import type { UpstreamServer } from './upstream-server';

export interface McpGatewayOptions {
  upstream: UpstreamServer;
  /** Names the upstream server in policy decisions and the audit trail. */
  serverName: string;
  /** Memnox runtime the per-request agent token is checked against. */
  runtimeUrl: string;
  host?: string;
  port?: number;
  path?: string;
  allowPattern?: string;
  denyPattern?: string;
  /** Forward calls when the runtime is unreachable. Default false — a firewall fails closed. */
  failOpen?: boolean;
  /**
   * Rules evaluated in this process, against the call's own arguments. The
   * gateway is where an argument stops travelling: it matches and scans here,
   * and the runtime is told only the tool name and what was found.
   */
  gate?: LocalGate;
  log?: (message: string) => void;
}

/**
 * A remote Streamable HTTP front door for an MCP server, so an agent running
 * somewhere this machine cannot reach — a hosted runner, a container, another
 * account's platform — is still gated. The stdio firewall can only govern a
 * server the client launches locally; this governs one it merely calls.
 *
 * Owns sockets and nothing else. Every routing decision is `GatewayExchange`'s.
 */
export class McpGateway {
  private readonly filter: ToolFilter;
  private readonly log: (message: string) => void;
  private readonly path: string;
  private server: Server | null = null;

  constructor(private readonly options: McpGatewayOptions) {
    this.log =
      options.log ?? ((message) => process.stderr.write(`[memnox] ${message}\n`));
    this.filter = new ToolFilter(options.allowPattern, options.denyPattern, this.log);
    this.path = options.path ?? DEFAULT_GATEWAY_PATH;
  }

  listen(): Promise<void> {
    const server = createServer((request, response) => {
      void this.route(request, response);
    });
    this.server = server;

    const port = this.options.port ?? DEFAULT_GATEWAY_PORT;
    const host = this.options.host ?? DEFAULT_GATEWAY_HOST;
    return new Promise((resolve) => {
      server.listen(port, host, () => {
        this.log(`mcp gateway on http://${host}:${port}${this.path}`);
        resolve();
      });
    });
  }

  /** The bound address, so a caller that asked for port 0 can find its port. */
  address(): { host: string; port: number } | null {
    const server = this.server;
    if (server === null) return null;
    const bound = server.address();
    if (bound === null || typeof bound === 'string') return null;
    return { host: bound.address, port: bound.port };
  }

  close(): Promise<void> {
    const server = this.server;
    if (server === null) return Promise.resolve();
    return new Promise((resolve) => server.close(() => resolve()));
  }

  private async route(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.url === undefined || pathOf(request.url) !== this.path) {
      return send(response, 404, { error: 'not found' });
    }
    // Server-initiated streams need a connection this proxy does not hold open;
    // say so rather than accept a GET and silently never deliver anything.
    if (request.method !== 'POST') {
      return send(response, 405, {
        error: 'this gateway proxies POSTed JSON-RPC only',
      });
    }

    const token = bearerOf(request.headers[HEADER_AUTHORIZATION]);
    // Fail closed on identity: without the caller's own token every call would
    // be attributed to the gateway, and the audit trail would name one agent
    // for an entire fleet.
    if (token === null) {
      return send(response, 401, {
        error: "present the calling agent's Memnox token as a bearer token",
      });
    }

    const body = await readBody(request);
    if (body === null) {
      return send(response, 413, { error: 'request body too large' });
    }

    const sessionId = headerOf(request.headers[HEADER_MCP_SESSION]);
    const exchange = new GatewayExchange({
      filter: this.filter,
      authorizer: this.authorizerFor(token, sessionId),
      upstream: this.options.upstream,
      sessionId,
      log: this.log,
    });

    const result = await exchange.handle(body);
    if (result.malformed) {
      return send(response, 400, { error: 'body is not JSON-RPC' });
    }
    // Notifications expect no answer; the spec's reply to that is 202.
    if (result.replies.length === 0) return send(response, 202, null);
    const single = result.replies[0];
    if (result.replies.length === 1 && single !== undefined) {
      return send(response, 200, single);
    }
    return send(response, 200, result.replies);
  }

  /**
   * Built per request, around the caller's own credential, so the runtime sees
   * the agent that actually made the call rather than this process.
   */
  private authorizerFor(token: string, sessionId?: string): CallAuthorizer {
    const runtime = new RuntimeAuthorizer(
      new MemnoxClient({ baseUrl: this.options.runtimeUrl, token }),
      {
        serverName: this.options.serverName,
        sessionId,
        failOpen: this.options.failOpen,
        log: this.log,
      },
    );
    const gate = this.options.gate;
    if (gate === undefined) return runtime;
    return new LayeredAuthorizer(
      new LocalGateAuthorizer(gate, this.options.serverName, sessionId),
      runtime,
    );
  }
}

function pathOf(url: string): string {
  const query = url.indexOf('?');
  return query === -1 ? url : url.slice(0, query);
}

function headerOf(value: string | string[] | undefined): string | undefined {
  if (value === undefined) return undefined;
  return Array.isArray(value) ? value[0] : value;
}

function bearerOf(value: string | string[] | undefined): string | null {
  const header = headerOf(value);
  if (header === undefined) return null;
  if (!header.startsWith(BEARER_PREFIX)) return null;
  const token = header.slice(BEARER_PREFIX.length).trim();
  return token.length === 0 ? null : token;
}

/** null means the caller exceeded the body cap and the socket was cut. */
function readBody(request: IncomingMessage): Promise<string | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        request.destroy();
        resolve(null);
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', () => resolve(null));
  });
}

function send(response: ServerResponse, status: number, body: unknown): void {
  if (body === null) {
    response.writeHead(status);
    response.end();
    return;
  }
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    [HEADER_CONTENT_TYPE]: CONTENT_TYPE_JSON,
    'content-length': Buffer.byteLength(payload).toString(),
  });
  response.end(payload);
}
