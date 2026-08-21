import type { CallAuthorizer } from './call-authorizer';
import { FirewallSession, type FirewallChannel } from './firewall-session';
import { parseMessage, type JsonRpcMessage } from './json-rpc';
import type { ToolFilter } from './tool-filter';
import type { UpstreamServer } from './upstream-server';

export interface GatewayExchangeDeps {
  filter: ToolFilter;
  authorizer: CallAuthorizer;
  upstream: UpstreamServer;
  /** Groups this client's calls in the audit timeline. */
  sessionId?: string;
  log: (message: string) => void;
}

/** `malformed` is the body failing to parse, which the caller answers 400 to. */
export type GatewayResult =
  { malformed: true } | { malformed: false; replies: JsonRpcMessage[] };

/** stdio gives two streams, HTTP a request and a reply; this adapts one onto the other. */
export class GatewayExchange {
  constructor(private readonly deps: GatewayExchangeDeps) {}

  async handle(body: string): Promise<GatewayResult> {
    const inbound = readInbound(body);
    if (inbound === null) return { malformed: true };

    const forClient: string[] = [];
    const forUpstream: string[] = [];
    const channel: FirewallChannel = {
      toServer: (payload) => {
        forUpstream.push(payload);
        return true;
      },
      toClient: (payload) => {
        forClient.push(payload);
      },
    };
    const session = new FirewallSession({
      filter: this.deps.filter,
      authorizer: this.deps.authorizer,
      channel,
      log: this.deps.log,
    });

    for (const message of inbound) {
      await session.fromClient(JSON.stringify(message));
    }
    for (const payload of forUpstream) {
      const replies = await this.deps.upstream.send(payload, this.deps.sessionId);
      for (const reply of replies) session.fromServer(reply);
    }

    return { malformed: false, replies: readReplies(forClient) };
  }
}

/** A payload the session emitted is always JSON it serialized itself. */
function readReplies(payloads: readonly string[]): JsonRpcMessage[] {
  const replies: JsonRpcMessage[] = [];
  for (const payload of payloads) {
    const message = parseMessage(payload);
    if (message !== null) replies.push(message);
  }
  return replies;
}

function readInbound(body: string): JsonRpcMessage[] | null {
  const trimmed = body.trim();
  if (trimmed.length === 0) return null;

  const parsed = parseJson(trimmed);
  if (parsed === null) return null;
  // A batch is an array; the spec allows either, and each entry is gated alike.
  if (Array.isArray(parsed)) {
    return parsed.length === 0 ? null : (parsed as JsonRpcMessage[]);
  }
  if (typeof parsed !== 'object') return null;
  return [parsed as JsonRpcMessage];
}

function parseJson(body: string): unknown {
  try {
    return JSON.parse(body) as unknown;
  } catch {
    // Not JSON at all — reported as a 400, never forwarded to the server.
    return null;
  }
}
