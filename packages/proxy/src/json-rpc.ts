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

/** One message, or the array a JSON-RPC batch arrives as. */
export type JsonRpcIncoming = JsonRpcMessage | readonly JsonRpcMessage[];

/**
 * Tells a batch from a single message, because casting an array to one gives it no
 * `method` and every rule that reads one then has nothing to match against.
 */
export function parseIncoming(line: string): JsonRpcIncoming | null {
  let parsed: unknown;
  try {
    // The peer is trusted to speak JSON-RPC; every
    // field is still checked before it is acted on.
    parsed = JSON.parse(line);
  } catch {
    // Not JSON, so pass raw output through untouched rather than corrupt the stream.
    return null;
  }
  // An empty batch is not a message either; it goes on raw and the peer answers for it.
  if (Array.isArray(parsed))
    return parsed.length === 0 ? null : (parsed as JsonRpcMessage[]);
  return typeof parsed === 'object' && parsed !== null
    ? (parsed as JsonRpcMessage)
    : null;
}

/** Null for a batch, which has no single identity to act on. */
export function parseMessage(line: string): JsonRpcMessage | null {
  const parsed = parseIncoming(line);
  return parsed === null || Array.isArray(parsed) ? null : (parsed as JsonRpcMessage);
}

export function serializeMessage(message: JsonRpcMessage): string {
  return `${JSON.stringify(message)}\n`;
}

/** A batch goes back as a batch, so the client's own framing is what it gets. */
export function serializeBatch(batch: readonly JsonRpcMessage[]): string {
  return `${JSON.stringify(batch)}\n`;
}
