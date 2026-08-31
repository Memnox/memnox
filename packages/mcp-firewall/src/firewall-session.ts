import { DECISION_EFFECT } from '@memnox/core';
import { isAllowed, type CallAuthorizer, type CallVerdict } from './call-authorizer';
import { METHOD_TOOLS_CALL, METHOD_TOOLS_LIST } from './firewall.constants';
import { parseMessage, serializeMessage, type JsonRpcMessage } from './json-rpc';
import {
  asContextBlock,
  digestArguments,
  frameResult,
  recordResult,
  resultText,
  type McpCallRecord,
} from './result-guard';
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
  /** Where a proxied call and its result are recorded; the ledger keeps no payload. */
  record?: (call: McpCallRecord) => void;
  /** Which server this session wraps, so a result names where it came from. */
  server?: string;
}

type MessageId = string | number;

const SERVER_GONE_REASON =
  'the wrapped MCP server is no longer running — restart the client to reconnect';

function describe(message: JsonRpcMessage): string {
  return message.method ?? 'response';
}

/**
 * Both directions. The call is checked on the way out and the result on the way back,
 * which is the only place a tool result can be caught trying to become an instruction.
 * Holds no process, so tests drive it directly.
 */
export class FirewallSession {
  private readonly listRequestIds = new Set<MessageId>();
  /** Open tool calls, so a reply can be matched to the call that asked for it. */
  /** The verdict rides with the call, so its result joins the same decision. */
  private readonly openCalls = new Map<
    MessageId,
    { call: ToolCall; decisionId?: string }
  >();

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
    if (isAllowed(verdict)) {
      if (id !== null) {
        this.openCalls.set(id, {
          call,
          ...(verdict.decisionId === undefined ? {} : { decisionId: verdict.decisionId }),
        });
      }
      this.record(call, undefined, verdict);
      return this.forward(message);
    }

    this.deps.log(`withheld tools/call "${call.name}": ${verdict.reason}`);
    this.record(call, undefined, verdict);
    this.deps.channel.toClient(
      serializeMessage(denial(message.id, verdict.reason, verdict.alternative)),
    );
  }

  fromServer(line: string): void {
    const message = parseMessage(line);
    if (!message) return this.deps.channel.toClient(`${line}\n`);

    const id = identify(message);
    if (id !== null && this.listRequestIds.has(id)) {
      this.listRequestIds.delete(id);
      return this.deps.channel.toClient(serializeMessage(this.filterListing(message)));
    }

    const open = id === null ? undefined : this.openCalls.get(id);
    if (open === undefined) return this.deps.channel.toClient(serializeMessage(message));
    const call = open.call;
    if (id !== null) this.openCalls.delete(id);

    /* Data cannot become authority because an agent read it. The result is wrapped as
       an untrusted context block whatever it says, and instruction-shaped content is
       recorded and framed rather than removed: silently editing a payload is a bug the
       agent cannot see and the reader cannot audit. */
    const result = recordResult(message);
    this.record(call, result, { decisionId: open.decisionId });
    if (result.containsInstruction) {
      this.deps.log(
        `tool result for "${call.name}" carried instruction-shaped content; it was quoted, not obeyed`,
      );
    }
    this.deps.channel.toClient(serializeMessage(frameResult(message, result)));
  }

  /** The result as the evaluator sees it: a block whose trust is set by its source. */
  contextBlockFor(
    call: ToolCall,
    message: JsonRpcMessage,
  ): ReturnType<typeof asContextBlock> {
    return asContextBlock(this.serverName, call.name, resultText(message));
  }

  private record(
    call: ToolCall,
    result: ReturnType<typeof recordResult> | undefined,
    verdict?: { decisionId?: string },
  ): void {
    const sink = this.deps.record;
    if (sink === undefined) return;
    sink({
      server: this.serverName,
      tool: call.name,
      argsDigest: digestArguments(call.arguments),
      ...(verdict === undefined || verdict.decisionId === undefined
        ? {}
        : { decisionId: verdict.decisionId }),
      ...(result === undefined ? {} : { result }),
    });
  }

  private get serverName(): string {
    return this.deps.server ?? 'unknown';
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

/**
 * An isError result, not a protocol error, so the model reads the denial reason — and
 * the alternative rides in the message, which is how the agent learns what to do
 * instead rather than abandoning the task.
 */
function denial(
  id: JsonRpcMessage['id'],
  reason: string,
  alternative?: { action: string; resource?: string; note: string },
): JsonRpcMessage {
  const instead =
    alternative === undefined
      ? ''
      : `\nInstead: ${alternative.action}${alternative.resource === undefined ? '' : ` ${alternative.resource}`} — ${alternative.note}`;
  return {
    jsonrpc: '2.0',
    id,
    result: {
      content: [{ type: 'text', text: `Withheld by Memnox: ${reason}${instead}` }],
      isError: true,
    },
  };
}
