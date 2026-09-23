/**
 * One `tools/call` as the gate needs it: the tool, and the
 * arguments flattened to strings, since a rule matches on values
 * a person wrote and nobody writes a matcher against JSON.
 */
export interface ToolCall {
  name: string;
  /**
   * Flattened to strings, which is what a policy matches; structured values as JSON text.
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
  // A non-array object, so every own key is an argument name.
  for (const [name, value] of Object.entries(input as Record<string, unknown>)) {
    flattened[name] = asText(value);
  }
  return flattened;
}

function asText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === undefined) return '';
  if (typeof value === 'object' && value !== null) return JSON.stringify(value);
  return String(value);
}
