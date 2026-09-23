import {
  DECISION_EFFECT,
  describeAlternative,
  describeHold,
  digest,
  isAllowed as holdAllowed,
  refusalShapeFor,
  renderNotes,
  RETRYABILITY,
  UNNAMED_AGENT,
  UNNAMED_SESSION,
  type Alternative,
  type HoldRequest,
  type HoldService,
  type RefusalShape,
  type SessionNote,
} from '@memnox/core';

import { isCallAllowed, type CallAuthorizer, type CallVerdict } from './call-authorizer';
import { METHOD_TOOLS_CALL, METHOD_TOOLS_LIST } from './firewall.constants';
import { parseMessage, serializeMessage, type JsonRpcMessage } from './json-rpc';
import {
  digestArguments,
  frameResult,
  resultRecordOf,
  type McpCallRecord,
  type McpResultRecord,
} from './result-guard';
import { readToolCall, type ToolCall } from './tool-call';
import type { ToolFilter } from './tool-filter';

/**
 * One client's session through the proxy: each call checked on the way out, each result
 * framed on the way back, and every message it does not own forwarded untouched.
 */

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
  /** Holds an ASK for a person. Absent means an ASK is a denial, and says so. */
  hold?: HoldService;
  /** Groups held calls, and scopes an "allow for this session" grant. */
  sessionId?: string;
  agent?: string;
  /**
   * What has been said to this agent in the workspace,
   * handed over with a result, for agents with no hooks.
   */
  notes?: () => Promise<SessionNote[]>;
  /** A result read like instructions, so the session is put under suspicion for a while. */
  onInstruction?: (call: ToolCall) => void;
}

type MessageId = string | number;

const SERVER_GONE_REASON =
  'the wrapped MCP server is no longer running, so restart the client to reconnect';

function describeMessage(message: JsonRpcMessage): string {
  return message.method ?? 'response';
}

/**
 * Both directions. The call is checked on the way out and the result on the way back,
 * which is the only place a tool result can be caught trying to become an instruction.
 * Holds no process, so tests drive it directly.
 */
export class FirewallSession {
  private readonly listRequestIds = new Set<MessageId>();
  /**
   * Open tool calls, with the verdict that let each
   * out, since the row is written when it returns.
   */
  private readonly openCalls = new Map<
    MessageId,
    { call: ToolCall; verdict: CallVerdict }
  >();

  /** Notes collected and not yet handed over, oldest first. */
  private waiting: SessionNote[] = [];
  /** One collection at a time, so a burst of calls asks once. */
  private collecting = false;

  constructor(private readonly deps: FirewallSessionDeps) {}

  /**
   * Asks for notes in the background while the call runs, never awaited, so the call does
   * not wait on the control plane and a note that arrives late rides on the next one.
   */
  private collectNotes(): void {
    const notes = this.deps.notes;
    if (notes === undefined || this.collecting) return;
    this.collecting = true;
    void notes()
      .then((found) => {
        this.waiting.push(...found);
      })
      .catch(() => undefined)
      .finally(() => {
        this.collecting = false;
      });
  }

  /** The result with whatever notes are waiting added after it, as one more block. */
  private withNotes(message: JsonRpcMessage): JsonRpcMessage {
    if (this.waiting.length === 0) return message;
    const result = message.result;
    if (result === undefined) return message;
    const content = result['content'];
    if (!Array.isArray(content)) return message;
    const notes = renderNotes(this.waiting);
    this.waiting = [];
    return {
      ...message,
      result: { ...result, content: [...content, { type: 'text', text: notes }] },
    };
  }

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
    let verdict = await this.verdictFor(call);
    if (verdict.effect === DECISION_EFFECT.ASK)
      verdict = await this.askPerson(call, verdict);
    if (isCallAllowed(verdict)) {
      // One call is one row, written when its result
      // arrives; a notification gets no reply to wait for.
      if (id === null) this.record(call, verdict, undefined);
      else this.openCalls.set(id, { call, verdict });
      this.collectNotes();
      return this.forward(message);
    }

    this.deps.log(`denied tools/call "${call.name}": ${verdict.reason}`);
    this.record(call, verdict, undefined);
    this.deps.channel.toClient(
      serializeMessage(denial(message.id, verdict.reason, verdict.alternative)),
    );
  }

  /**
   * The call waits here, which is the whole point: the agent is blocked on a pipe and
   * a person answers before anything reaches the wrapped server.
   */
  private async askPerson(call: ToolCall, verdict: CallVerdict): Promise<CallVerdict> {
    const hold = this.deps.hold;
    const request: HoldRequest = {
      sessionId: this.deps.sessionId ?? UNNAMED_SESSION,
      agent: this.deps.agent ?? UNNAMED_AGENT,
      operation: call.name,
      fingerprint: digest(`${call.name}:${JSON.stringify(call.arguments ?? {})}`),
      reason: verdict.reason,
      ...(this.deps.server === undefined ? {} : { target: this.deps.server }),
    };

    if (hold === undefined) {
      return {
        ...verdict,
        effect: DECISION_EFFECT.DENY,
        reason: `${verdict.reason} (nobody could be asked, so it was denied)`,
      };
    }

    const result = await hold.hold(request);
    if (holdAllowed(result)) {
      this.deps.authorizer.personAllowed?.(call);
      return { ...verdict, effect: DECISION_EFFECT.ALLOW, reason: 'a person allowed it' };
    }
    return {
      ...verdict,
      effect: DECISION_EFFECT.DENY,
      reason: describeHold(result, request),
    };
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
    // Whatever was held while it ran is let go now, not
    // awaited, so the agent never waits on the plane.
    const authorizer = this.deps.authorizer;
    if (authorizer.settle !== undefined) {
      void authorizer.settle(call).catch(() => undefined);
    }

    // Data cannot become authority because an agent read it, so instruction-shaped
    // content is framed rather than removed: a silent edit is a bug nobody can audit.
    const result = resultRecordOf(message);
    this.record(call, open.verdict, result);
    if (result.containsInstruction) {
      this.deps.log(
        `tool result for "${call.name}" carried instruction-shaped content; it was quoted, not obeyed`,
      );
      this.deps.onInstruction?.(call);
    }
    this.deps.channel.toClient(
      serializeMessage(this.withNotes(frameResult(message, result))),
    );
  }

  private record(
    call: ToolCall,
    verdict: CallVerdict,
    result: McpResultRecord | undefined,
  ): void {
    const sink = this.deps.record;
    if (sink === undefined) return;
    sink({
      server: this.serverName,
      tool: call.name,
      argsDigest: digestArguments(call.arguments),
      effect: verdict.effect,
      reason: verdict.reason,
      ...(verdict.rule === undefined ? {} : { rule: verdict.rule }),
      ...(verdict.decisionId === undefined ? {} : { decisionId: verdict.decisionId }),
      ...(result === undefined ? {} : { result }),
    });
  }

  private get serverName(): string {
    return this.deps.server ?? 'unknown';
  }

  private async verdictFor(call: ToolCall): Promise<CallVerdict> {
    if (!this.deps.filter.isAllowed(call.name)) {
      return {
        effect: DECISION_EFFECT.DENY,
        reason: `tool "${call.name}" is denied by the static filter`,
      };
    }
    return this.deps.authorizer.authorize(call);
  }

  private filterListing(message: JsonRpcMessage): JsonRpcMessage {
    const tools = message.result === undefined ? undefined : message.result['tools'];
    if (!Array.isArray(tools)) return message;
    const visible = tools.filter((tool: unknown) =>
      this.deps.filter.isAllowed(toolNameOf(tool)),
    );
    return { ...message, result: { ...message.result, tools: visible } };
  }

  /**
   * A dropped write must not look like success, because the dead server will never reply.
   */
  private forward(message: JsonRpcMessage): void {
    if (this.deps.channel.toServer(serializeMessage(message))) return;

    this.deps.log(
      `wrapped server is not accepting input; dropped ${describeMessage(message)}`,
    );
    // A notification expects no reply.
    if (identify(message) === null) return;
    // The upstream died: transient, and the one refusal here that a retry can fix.
    this.deps.channel.toClient(
      serializeMessage(
        denial(message.id, SERVER_GONE_REASON, undefined, {
          retryability: RETRYABILITY.LATER,
          guidance:
            'The server this call needed is not running. This is a failure, not a rule: retrying once it is back may succeed.',
        }),
      ),
    );
  }

  private forwardRaw(payload: string): void {
    if (this.deps.channel.toServer(payload)) return;
    this.deps.log('wrapped server is not accepting input; dropped a raw line');
  }
}

function toolNameOf(tool: unknown): string {
  if (typeof tool !== 'object' || tool === null) return '';
  const name: unknown = Reflect.get(tool, 'name');
  return String(name ?? '');
}

function identify(message: JsonRpcMessage): MessageId | null {
  return message.id === undefined || message.id === null ? null : message.id;
}

/**
 * An isError result rather than a protocol error, so the model reads the reason and the
 * alternative, and whether retrying could ever work, or it retries a rule forty times.
 */
function denial(
  id: JsonRpcMessage['id'],
  reason: string,
  alternative?: Alternative,
  shape: RefusalShape = refusalShapeFor(DECISION_EFFECT.DENY, reason),
): JsonRpcMessage {
  const instead =
    alternative === undefined ? '' : `\n${describeAlternative(alternative)}`;
  return {
    jsonrpc: '2.0',
    id,
    result: {
      content: [
        {
          type: 'text',
          text: `Denied by Memnox: ${reason}${instead}\n${shape.guidance}`,
        },
      ],
      isError: true,
    },
  };
}
