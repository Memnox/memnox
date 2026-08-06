import { CLI_VERSION } from '../defaults';
import { callTool, MCP_TOOLS, type ToolRuntime } from './mcp-tools';

/** MCP framing, kept local so the CLI does not depend on the firewall package. */
interface JsonRpcMessage {
  jsonrpc: '2.0';
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: Record<string, unknown>;
}

const PROTOCOL_VERSION = '2024-11-05';
const SERVER_NAME = 'memnox';
const METHOD_NOT_FOUND = -32601;

/**
 * The Memnox MCP server: message in, message out, no sockets.
 *
 * Every routing decision lives here so tests drive the real protocol without
 * stdin — the same seam `FirewallSession` uses. Returning null means "no reply",
 * which is what a notification expects.
 */
export class McpServer {
  constructor(private readonly runtime: ToolRuntime) {}

  async handle(message: JsonRpcMessage): Promise<JsonRpcMessage | null> {
    const { method, id } = message;
    if (method === 'initialize') {
      return this.reply(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: SERVER_NAME, version: CLI_VERSION },
      });
    }
    // Notifications carry no id and expect nothing back.
    if (id === undefined || id === null) return null;

    if (method === 'tools/list') return this.reply(id, { tools: [...MCP_TOOLS] });
    if (method === 'tools/call') return this.callTool(id, message.params);
    if (method === 'ping') return this.reply(id, {});

    return {
      jsonrpc: '2.0',
      id,
      error: { code: METHOD_NOT_FOUND, message: `unsupported method "${method}"` },
    };
  }

  /**
   * A refusal comes back as an isError *result*, never a protocol error, so the
   * model reads the reason and can act on it instead of seeing a broken tool.
   */
  private async callTool(
    id: JsonRpcMessage['id'],
    params: Record<string, unknown> | undefined,
  ): Promise<JsonRpcMessage> {
    const name = params === undefined ? '' : String(params['name'] ?? '');
    const rawArgs = params === undefined ? undefined : params['arguments'];
    const args =
      typeof rawArgs === 'object' && rawArgs !== null
        ? (rawArgs as Record<string, unknown>)
        : {};

    const result = await callTool(name, args, this.runtime);
    return this.reply(id, {
      content: [{ type: 'text', text: result.text }],
      isError: result.isError,
    });
  }

  private reply(
    id: JsonRpcMessage['id'],
    result: Record<string, unknown>,
  ): JsonRpcMessage {
    return { jsonrpc: '2.0', id: id ?? null, result };
  }
}

/** Frames newline-delimited JSON, the MCP stdio transport. */
export class LineBuffer {
  private pending = '';

  push(chunk: string): string[] {
    this.pending += chunk;
    const lines = this.pending.split('\n');
    this.pending = lines.pop() ?? '';
    return lines.filter((line) => line.trim().length > 0);
  }
}

export function parseMessage(line: string): JsonRpcMessage | null {
  try {
    return JSON.parse(line) as JsonRpcMessage;
  } catch {
    // A malformed line is the client's problem to fix; dropping it keeps the
    // stream usable rather than killing the session.
    return null;
  }
}

export function serializeMessage(message: JsonRpcMessage): string {
  return `${JSON.stringify(message)}\n`;
}
