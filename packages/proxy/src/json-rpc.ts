/**
 * The wire MCP speaks: newline-delimited JSON over stdio. Anything that is not JSON
 * passes through untouched, so a server writing a stray line cannot take the stream down.
 */
export interface JsonRpcMessage {
  jsonrpc: '2.0';
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: Record<string, unknown>;
}

/**
 * The framing this transport uses, shared with the discovery lister that reads it too.
 */
export { LineBuffer } from '@memnox/core';

export function parseMessage(line: string): JsonRpcMessage | null {
  try {
    // The peer is trusted to speak JSON-RPC; every
    // field is still checked before it is acted on.
    return JSON.parse(line) as JsonRpcMessage;
  } catch {
    // Not JSON, so pass raw output through untouched rather than corrupt the stream.
    return null;
  }
}

export function serializeMessage(message: JsonRpcMessage): string {
  return `${JSON.stringify(message)}\n`;
}
