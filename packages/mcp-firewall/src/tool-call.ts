import type { JsonRpcMessage } from './json-rpc';

export interface ToolCall {
  name: string;
  /**
   * The call's arguments flattened to strings, which is what a policy matches
   * and the scanner reads. Structured values are carried as their JSON text.
   */
  arguments: Record<string, string>;
}

const ARGUMENTS_KEY = 'arguments';
const NAME_KEY = 'name';

/** Reads the tool call out of a `tools/call` params object, tolerantly. */
export function readToolCall(params: Record<string, unknown> | undefined): ToolCall {
  if (params === undefined) return { name: '', arguments: {} };
  return {
    name: String(params[NAME_KEY] ?? ''),
    arguments: flattenArguments(params[ARGUMENTS_KEY]),
  };
}

export function flattenArguments(input: unknown): Record<string, string> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return {};

  const flattened: Record<string, string> = {};
  for (const [name, value] of Object.entries(input as Record<string, unknown>)) {
    flattened[name] = asText(value);
  }
  return flattened;
}

/**
 * Rebuilds the message with masked arguments. Null means the masking cannot be
 * put back faithfully — a structured argument carried a secret, and rewriting
 * its JSON text would change the call's shape — so the caller blocks instead.
 */
export function withRedactedArguments(
  message: JsonRpcMessage,
  redacted: Record<string, string>,
): JsonRpcMessage | null {
  const params = message.params;
  if (params === undefined) return null;

  const original = params[ARGUMENTS_KEY];
  if (typeof original !== 'object' || original === null || Array.isArray(original)) {
    return null;
  }

  const rewritten: Record<string, unknown> = { ...(original as Record<string, unknown>) };
  for (const [name, masked] of Object.entries(redacted)) {
    const current = rewritten[name];
    if (typeof current === 'string') {
      rewritten[name] = masked;
      continue;
    }
    if (asText(current) !== masked) return null;
  }
  return { ...message, params: { ...params, [ARGUMENTS_KEY]: rewritten } };
}

function asText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === undefined) return '';
  if (typeof value === 'object' && value !== null) return JSON.stringify(value);
  return String(value);
}
