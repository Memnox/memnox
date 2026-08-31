import { DECISION_EFFECT } from '@memnox/core';
import { isAllowed, type CallAuthorizer, type CallVerdict } from './call-authorizer';
import { METHOD_TOOLS_CALL, METHOD_TOOLS_LIST } from './firewall.constants';
import { parseMessage, serializeMessage, type JsonRpcMessage } from './json-rpc';
import { readToolCall, type ToolCall } from './tool-call';
import type { ToolFilter } from './tool-filter';

/** The two directions a proxied message can travel. */
export interface FirewallChannel {
  /** False means the wrapped server can no longer accept input. */
  toServer(payload: string): boolean;
  toClient(payload: string): void;
}

export interface FirewallSessionDeps {
  filter: ToolFilter;
  authorizer: CallAuthorizer;
  channel: FirewallChannel;
  log: (message: string) => void;
}

type MessageId = string | number;

const SERVER_GONE_REASON =
  'the wrapped MCP server is no longer running — restart the client to reconnect';

function describe(message: JsonRpcMessage): string {
  return message.method ?? 'response';
}

/** tools/call is gated, tools/list filtered; holds no process, so tests drive it. */
export class FirewallSession {
  private readonly listRequestIds = new Set<MessageId>();

  constructor(private readonly deps: FirewallSessionDeps) {}

  async fromClient(line: string): Promise<void> {
    const message = parseMessage(line);
    if (!message) return this.forwardRaw(`${line}\n`);

    const id = identify(message);
    if (message.method === METHOD_TOOLS_LIST && id !== null) {
      this.listRequestIds.add(id);
      return this.forward(message);
    }
    if (message.method !== METHOD_TOOLS_CALL) return this.forward(message);

    const call = readToolCall(message.params);
    const verdict = await this.verdictFor(call);
    if (isAllowed(verdict)) return this.forward(message);

    this.deps.log(`withheld tools/call "${call.name}": ${verdict.reason}`);
    this.deps.channel.toClient(serializeMessage(denial(message.id, verdict.reason)));
  }

  fromServer(line: string): void {
    const message = parseMessage(line);
    if (!message) return this.deps.channel.toClient(`${line}\n`);

    const id = identify(message);
    if (id !== null && this.listRequestIds.has(id)) {
      this.listRequestIds.delete(id);
      return this.deps.channel.toClient(serializeMessage(this.filterListing(message)));
    }
    this.deps.channel.toClient(serializeMessage(message));
  }

  private async verdictFor(call: ToolCall): Promise<CallVerdict> {
    if (!this.deps.filter.isAllowed(call.name)) {
      return {
        effect: DECISION_EFFECT.WITHHOLD,
        reason: `tool "${call.name}" is denied by the static filter`,
      };
    }
    return this.deps.authorizer.authorize(call);
  }

  private filterListing(message: JsonRpcMessage): JsonRpcMessage {
    const tools = message.result === undefined ? undefined : message.result['tools'];
    if (!Array.isArray(tools)) return message;
    const visible = (tools as Array<Record<string, unknown>>).filter((tool) =>
      this.deps.filter.isAllowed(String(tool['name'] ?? '')),
    );
    return { ...message, result: { ...message.result, tools: visible } };
  }

  /** A dropped write must not look like success — the dead server will never reply. */
  private forward(message: JsonRpcMessage): void {
    if (this.deps.channel.toServer(serializeMessage(message))) return;

    this.deps.log(`wrapped server is not accepting input; dropped ${describe(message)}`);
    if (identify(message) === null) return; // A notification expects no reply.
    this.deps.channel.toClient(serializeMessage(denial(message.id, SERVER_GONE_REASON)));
  }

  private forwardRaw(payload: string): void {
    if (this.deps.channel.toServer(payload)) return;
    this.deps.log('wrapped server is not accepting input; dropped a raw line');
  }
}

function identify(message: JsonRpcMessage): MessageId | null {
  return message.id === undefined || message.id === null ? null : message.id;
}

/** An isError result, not a protocol error, so the model reads the denial reason. */
function denial(id: JsonRpcMessage['id'], reason: string): JsonRpcMessage {
  return {
    jsonrpc: '2.0',
    id,
    result: {
      content: [{ type: 'text', text: `Withheld by Memnox: ${reason}` }],
      isError: true,
    },
  };
}
