import {
  DECISION_EFFECT,
  describeHold,
  digest,
  isAllowed as holdAllowed,
  refusalShapeFor,
  renderNotes,
  RETRYABILITY,
  type SessionNote,
  type RefusalShape,
  type HoldRequest,
  type HoldService,
} from '@memnox/core';
import { isAllowed, type CallAuthorizer, type CallVerdict } from './call-authorizer';
import { METHOD_TOOLS_CALL, METHOD_TOOLS_LIST } from './firewall.constants';
import { parseMessage, serializeMessage, type JsonRpcMessage } from './json-rpc';
import {
  digestArguments,
  frameResult,
  recordResult,
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
  /** Holds an ASK for a person. Absent means an ASK is a denial, and says so. */
  hold?: HoldService;
  /** Groups held calls, and scopes an "allow for this session" grant. */
  sessionId?: string;
  agent?: string;
  /**
   * Collects what has been said to this agent in the workspace. Asked when a call
   * goes out and handed over when its result comes back, so an agent with no
   * hooks of its own, which reaches the world only through MCP, is still told.
   */
  notes?: () => Promise<SessionNote[]>;
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
  /**
   * Open tool calls, so a reply can be matched to the call that asked for it. The
   * verdict rides along because the row is written when the outcome is known, and by
   * then the decision that allowed it is several messages behind.
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
   * Asks for notes in the background while the call runs.
   *
   * Never awaited: the call must not wait on the control plane, and a result that
   * comes back before the answer simply carries the notes on the next one. Once
   * collected a note is the proxy's to deliver, since the workspace has marked it
   * handed over.
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
    if (isAllowed(verdict)) {
      /* The row waits for the result, so one call is one row carrying what came back.
         A notification gets no reply, so nothing would ever arrive to write it. */
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
      sessionId: this.deps.sessionId ?? 'ses_local',
      agent: this.deps.agent ?? 'an agent',
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
    /* The work is done, so whatever was held while it ran is let go now rather
       than when its window runs out. Not awaited: the agent is waiting on this
       result, and a slow control plane must not be what it waits for. */
    const authorizer = this.deps.authorizer;
    if (authorizer.settle !== undefined) {
      void authorizer.settle(call).catch(() => undefined);
    }

    /* Data cannot become authority because an agent read it. The result is wrapped as
       an untrusted context block whatever it says, and instruction-shaped content is
       recorded and framed rather than removed: silently editing a payload is a bug the
       agent cannot see and the reader cannot audit. */
    const result = recordResult(message);
    this.record(call, open.verdict, result);
    if (result.containsInstruction) {
      this.deps.log(
        `tool result for "${call.name}" carried instruction-shaped content; it was quoted, not obeyed`,
      );
    }
    this.deps.channel.toClient(
      serializeMessage(this.withNotes(frameResult(message, result))),
    );
  }

  private record(
    call: ToolCall,
    verdict: CallVerdict,
    result: ReturnType<typeof recordResult> | undefined,
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
    /* The upstream died: transient, and the one refusal here that a retry can fix.
       Telling the model "policy decision, do not retry" would be wrong the other way. */
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

function identify(message: JsonRpcMessage): MessageId | null {
  return message.id === undefined || message.id === null ? null : message.id;
}

/**
 * An isError result, not a protocol error, so the model reads the denial reason — and
 * the alternative rides in the message, which is how the agent learns what to do
 * instead rather than abandoning the task.
 *
 * The shape says whether retrying could ever work. Without it a refusal reads as a
 * transient failure, and the agent retries a rule forty times — which is the loop the
 * circuit breaker exists to stop, arriving from the one place that could have said so.
 */
function denial(
  id: JsonRpcMessage['id'],
  reason: string,
  alternative?: { action: string; resource?: string; note: string },
  shape: RefusalShape = refusalShapeFor(DECISION_EFFECT.DENY, reason),
): JsonRpcMessage {
  const instead =
    alternative === undefined
      ? ''
      : `\nInstead: ${alternative.action}${alternative.resource === undefined ? '' : ` ${alternative.resource}`} — ${alternative.note}`;
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
