import { spawn, type ChildProcess } from 'node:child_process';
import { LineBuffer } from '../domain/line-buffer';
import { MCP_PROBE_TIMEOUT_MS, MCP_PROTOCOL_VERSION } from './discovery.constants';
import type { McpLister } from './ports';
import type { McpToolDeclaration } from './surface';

/**
 * Asking a server what tools it holds, the one place discovery starts a process. Bounded
 * by a timeout, always killed, and never throws, so a dead server is a gap in the report.
 */

/** Re-exported: this module owns the MCP stdio transport that frames with it. */
export { LineBuffer };

/** Ids are local to one short conversation; nothing else ever reads them. */
const INITIALIZE_ID = 1;
const TOOLS_LIST_ID = 2;

interface JsonRpcReply {
  id?: unknown;
  result?: { tools?: unknown };
}

export interface McpListerDeps {
  spawn?: (command: string, args: readonly string[]) => ChildProcess;
  timeoutMs?: number;
}

function defaultSpawn(command: string, args: readonly string[]): ChildProcess {
  // stderr is discarded: a server's startup noise is not this report's business.
  return spawn(command, [...args], { stdio: ['pipe', 'pipe', 'ignore'] });
}

/** Asks a server what it holds, because a config says what it is called and never what it can do. */
export class NodeMcpLister implements McpLister {
  constructor(private readonly deps: McpListerDeps = {}) {}

  async listTools(
    _server: string,
    command: string,
    args: readonly string[],
  ): Promise<McpToolDeclaration[]> {
    const child = this.start(command, args);
    if (child === null) return [];

    try {
      return await this.converse(child);
    } catch {
      // An unreadable server is absence. The surface still names it as present.
      return [];
    } finally {
      child.kill();
    }
  }

  private start(command: string, args: readonly string[]): ChildProcess | null {
    const spawnChild = this.deps.spawn ?? defaultSpawn;
    try {
      return spawnChild(command, args);
    } catch {
      // A command that is not installed is a real state on somebody's machine.
      return null;
    }
  }

  private async converse(child: ChildProcess): Promise<McpToolDeclaration[]> {
    const stdin = child.stdin;
    const stdout = child.stdout;
    if (stdin === null || stdout === null) return [];

    return new Promise<McpToolDeclaration[]>((resolve) => {
      // A server that never answers must not hold the whole scan open.
      const finish = settleOnce(resolve, this.deps.timeoutMs ?? MCP_PROBE_TIMEOUT_MS);
      child.on('error', () => finish([]));
      child.on('exit', () => finish([]));

      const buffer = new LineBuffer();
      stdout.on('data', (chunk: Buffer) => {
        for (const line of buffer.push(chunk.toString('utf8'))) {
          answerReply(stdin, parseReply(line), finish);
        }
      });
      write(stdin, INITIALIZE_REQUEST);
    });
  }
}

type Finish = (tools: McpToolDeclaration[]) => void;

const INITIALIZE_REQUEST = {
  jsonrpc: '2.0',
  id: INITIALIZE_ID,
  method: 'initialize',
  params: {
    protocolVersion: MCP_PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: 'memnox-discovery', version: '1' },
  },
};

/** A resolver that answers once, and with nothing when the timeout comes first. */
function settleOnce(resolve: Finish, timeoutMs: number): Finish {
  let settled = false;
  const timer = setTimeout(() => finish([]), timeoutMs);
  function finish(tools: McpToolDeclaration[]): void {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    resolve(tools);
  }
  return finish;
}

/** Initialized, ask for the tools; tools listed, done. Anything else is not ours. */
function answerReply(
  stdin: NodeJS.WritableStream,
  reply: JsonRpcReply | null,
  finish: Finish,
): void {
  if (reply === null) return;
  if (reply.id === INITIALIZE_ID) {
    write(stdin, { jsonrpc: '2.0', method: 'notifications/initialized' });
    write(stdin, { jsonrpc: '2.0', id: TOOLS_LIST_ID, method: 'tools/list' });
    return;
  }
  if (reply.id === TOOLS_LIST_ID) finish(readDeclarations(reply));
}

function write(stream: NodeJS.WritableStream, message: unknown): void {
  try {
    stream.write(`${JSON.stringify(message)}\n`);
  } catch {
    // A closed pipe means the server is gone; the timeout resolves the scan.
  }
}

function parseReply(line: string): JsonRpcReply | null {
  try {
    const parsed: unknown = JSON.parse(line);
    if (typeof parsed !== 'object' || parsed === null) return null;
    // Every field of a reply is optional and checked where it is read.
    return parsed as JsonRpcReply;
  } catch {
    // Servers print non-JSON on stdout more often than they should.
    return null;
  }
}

/** Tolerant on purpose: one malformed tool must not lose the rest of the list. */
function readDeclarations(reply: JsonRpcReply): McpToolDeclaration[] {
  const result = reply.result;
  if (result === undefined) return [];
  const tools = result.tools;
  if (!Array.isArray(tools)) return [];

  const declarations: McpToolDeclaration[] = [];
  for (const raw of tools) {
    if (typeof raw !== 'object' || raw === null) continue;
    // Narrowed to an object above; each field is checked before it is kept.
    const tool = raw as Record<string, unknown>;
    const name = tool['name'];
    if (typeof name !== 'string' || name.length === 0) continue;

    const { description, annotations, inputSchema } = tool;
    declarations.push({
      name,
      ...(typeof description === 'string' ? { description } : {}),
      ...(isRecord(annotations) ? { annotations } : {}),
      ...(isRecord(inputSchema) ? { inputSchema } : {}),
    });
  }
  return declarations;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
