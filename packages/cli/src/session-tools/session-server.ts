/**
 * The session server's wire: MCP over newline-delimited JSON on stdio, answering
 * `initialize`, `tools/list` and `tools/call`, and asking the person through the host where it can.
 */
import { LineBuffer, readWorkspaceMemoryCached } from '@memnox/core';

import { answerText } from './bounded';
import type { SessionToolDeps } from './read-tools';
import type { RewindSeams } from './rewind-tool';
import { callTool, SESSION_TOOLS } from './session-tools';

/** Spoken when the host names none, the revision whose elicitation this server uses. */
const PROTOCOL_VERSION = '2025-06-18';

const SERVER_INFO = { name: 'memnox-session', version: '1' } as const;

/** A person may take a while to read a rewind question; after this it is a no. */
const CONFIRM_TIMEOUT_MS = 5 * 60 * 1_000;

const RPC_ERROR = { PARSE: -32700, METHOD: -32601, PARAMS: -32602 } as const;

interface Message {
  jsonrpc: '2.0';
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: Record<string, unknown>;
}

interface SessionServerOptions {
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
  deps: SessionToolDeps;
  seams: Omit<RewindSeams, 'confirm'>;
}

/** One connection's state: whether the host can ask its person, and the questions in flight. */
class SessionConnection {
  private canElicit = false;
  private nextId = 0;
  private readonly waiting = new Map<string, (accepted: boolean) => void>();

  constructor(private readonly options: SessionServerOptions) {}

  send(message: Omit<Message, 'jsonrpc'>): void {
    this.options.output.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
  }

  async receive(message: Message | null): Promise<void> {
    if (message === null) {
      this.send({ id: null, error: { code: RPC_ERROR.PARSE, message: 'not JSON' } });
      return;
    }
    if (message.method === undefined) return this.answered(message);
    if (message.id === undefined) return;
    await this.request(message.id, message.method, message.params ?? {});
  }

  answered(message: Message): void {
    const key = String(message.id);
    const resolve = this.waiting.get(key);
    if (resolve === undefined) return;
    this.waiting.delete(key);
    resolve(message.result !== undefined && message.result['action'] === 'accept');
  }

  private async request(
    id: string | number | null,
    method: string,
    params: Record<string, unknown>,
  ): Promise<void> {
    if (method === 'initialize')
      return this.send({ id, result: await this.initialized(params) });
    if (method === 'ping') return this.send({ id, result: {} });
    if (method === 'tools/list')
      return this.send({ id, result: { tools: [...SESSION_TOOLS] } });
    if (method !== 'tools/call') {
      return this.send({
        id,
        error: { code: RPC_ERROR.METHOD, message: `no method ${method}` },
      });
    }
    const name = params['name'];
    const args = params['arguments'];
    if (typeof name !== 'string') {
      return this.send({
        id,
        error: { code: RPC_ERROR.PARAMS, message: 'a tool call names a tool' },
      });
    }
    const record =
      args !== null && typeof args === 'object' ? (args as Record<string, unknown>) : {};
    this.send({ id, result: await this.called(name, record) });
  }

  private async initialized(
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const capabilities = params['capabilities'];
    this.canElicit =
      capabilities !== null &&
      typeof capabilities === 'object' &&
      'elicitation' in capabilities;
    const asked = params['protocolVersion'];
    return {
      protocolVersion: typeof asked === 'string' ? asked : PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: SERVER_INFO,
      instructions: await instructionsFor(this.options.deps.home),
    };
  }

  private async called(
    name: string,
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const seams: RewindSeams = {
      ...this.options.seams,
      confirm: (message) => this.confirm(message),
    };
    try {
      const answer = await callTool(this.options.deps, seams, name, args);
      if (answer === null) return textResult(`No tool ${name}.`, true);
      return textResult(answerText(answer), false);
    } catch (err) {
      // Said to the agent as the tool's answer, which is where a person reading along sees it.
      return textResult(err instanceof Error ? err.message : String(err), true);
    }
  }

  /** Asks the person directly where the host can; null leaves it to the host's own prompt. */
  private async confirm(message: string): Promise<boolean | null> {
    if (!this.canElicit) return null;
    const id = `memnox-${(this.nextId += 1)}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => this.settle(id, false), CONFIRM_TIMEOUT_MS);
      this.waiting.set(id, (accepted) => {
        clearTimeout(timer);
        resolve(accepted);
      });
      this.send({
        id,
        method: 'elicitation/create',
        params: { message, requestedSchema: { type: 'object', properties: {} } },
      });
    });
  }

  private settle(id: string, accepted: boolean): void {
    const resolve = this.waiting.get(id);
    this.waiting.delete(id);
    if (resolve !== undefined) resolve(accepted);
  }
}

function textResult(text: string, isError: boolean): Record<string, unknown> {
  return { content: [{ type: 'text', text }], isError };
}

/** Serves until the host closes stdin; calls run one at a time, in the order they came. */
export function serveSession(options: SessionServerOptions): Promise<void> {
  const connection = new SessionConnection(options);
  const lines = new LineBuffer();
  let queue = Promise.resolve();
  return new Promise((resolve) => {
    options.input.setEncoding('utf8');
    options.input.on('data', (chunk: string) => {
      for (const line of lines.push(chunk)) {
        const message = parsed(line);
        // Answers to our own questions go straight through, or a queued call waiting on one never ends.
        if (message !== null && message.method === undefined)
          connection.answered(message);
        else queue = queue.then(() => connection.receive(message));
      }
    });
    options.input.on('end', () => void queue.then(resolve));
  });
}

function parsed(line: string): Message | null {
  try {
    // Every field is checked before it is acted on.
    const value: unknown = JSON.parse(line);
    return value !== null && typeof value === 'object' ? (value as Message) : null;
  } catch {
    // Not JSON: answered with a parse error rather than taking the stream down.
    return null;
  }
}

const ABOUT_SESSION =
  'Memnox answers questions about this session for your person. It can explain, report and rewind; it can never approve, allow or change a rule.';

/**
 * Read by every host at connect, which makes it the one place an agent whose hooks add no
 * context (Cursor, Windsurf) still learns to ask what its workspace settled before it edits.
 */
async function instructionsFor(home: string): Promise<string> {
  const memory = await readWorkspaceMemoryCached(home).catch(() => null);
  if (memory === null || memory.facts.length === 0) return ABOUT_SESSION;
  return `${ABOUT_SESSION} Your workspace has settled ${memory.facts.length} decision(s), policies and owners: before you change code, call "brief" with the paths you are about to edit, or "memory" with the subject, and cite what it says. Where your task disagrees with it, ask your person first.`;
}
