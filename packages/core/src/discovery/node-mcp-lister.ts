import { spawn, type ChildProcess } from 'node:child_process';
import { MCP_PROBE_TIMEOUT_MS, MCP_PROTOCOL_VERSION } from './discovery.constants';
import type { McpLister } from './ports';
import type { McpToolDeclaration } from './surface';

/** Ids are local to one short conversation; nothing else ever reads them. */
const INITIALIZE_ID = 1;
const TOOLS_LIST_ID = 2;

interface JsonRpcReply {
  id?: unknown;
  result?: { tools?: unknown };
}

/**
 * Splits a stdio stream into whole JSON-RPC lines. A partial write is normal on a
 * pipe, and treating one as a message loses the tool list of a chatty server.
 */
export class LineBuffer {
  private pending = '';

  push(chunk: string): string[] {
    this.pending += chunk;
    const lines = this.pending.split('\n');
    this.pending = lines.pop() ?? '';
    return lines.filter((line) => line.trim().length > 0);
  }
}

export interface McpListerDeps {
  spawn?: (command: string, args: readonly string[]) => ChildProcess;
  timeoutMs?: number;
}

const defaultSpawn = (command: string, args: readonly string[]): ChildProcess =>
  // stderr is discarded: a server's startup noise is not this report's business.
  spawn(command, [...args], { stdio: ['pipe', 'pipe', 'ignore'] });

/**
 * Asks a server what it holds, because a config says what a server is called and never
 * what it can do. This is the one place discovery starts a process rather than reading
 * a file, so it is bounded by a timeout, always killed, and never throws: a server that
 * will not start is a gap in the report, not a crash.
 */
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
      const buffer = new LineBuffer();
      let settled = false;

      const finish = (tools: McpToolDeclaration[]): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(tools);
      };

      // A server that never answers must not hold the whole scan open.
      const timer = setTimeout(
        () => finish([]),
        this.deps.timeoutMs ?? MCP_PROBE_TIMEOUT_MS,
      );

      child.on('error', () => finish([]));
      child.on('exit', () => finish([]));

      stdout.on('data', (chunk: Buffer) => {
        for (const line of buffer.push(chunk.toString('utf8'))) {
          const reply = parseReply(line);
          if (reply === null) continue;

          if (reply.id === INITIALIZE_ID) {
            write(stdin, { jsonrpc: '2.0', method: 'notifications/initialized' });
            write(stdin, { jsonrpc: '2.0', id: TOOLS_LIST_ID, method: 'tools/list' });
            continue;
          }
          if (reply.id === TOOLS_LIST_ID) finish(readDeclarations(reply));
        }
      });

      write(stdin, {
        jsonrpc: '2.0',
        id: INITIALIZE_ID,
        method: 'initialize',
        params: {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: 'memnox-discovery', version: '1' },
        },
      });
    });
  }
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
    const tool = raw as Record<string, unknown>;
    const name = tool['name'];
    if (typeof name !== 'string' || name.length === 0) continue;

    declarations.push({
      name,
      ...(typeof tool['description'] === 'string'
        ? { description: tool['description'] }
        : {}),
      ...(isRecord(tool['annotations']) ? { annotations: tool['annotations'] } : {}),
      ...(isRecord(tool['inputSchema'])
        ? { inputSchema: tool['inputSchema'] as { properties?: Record<string, unknown> } }
        : {}),
    });
  }
  return declarations;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
