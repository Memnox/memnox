import { HOOK_EVENT_NAME } from './tool-hook.constants';

/**
 * What the host writes on stdin before a tool runs. Only the fields this seam rules
 * on are modelled; the rest of the payload is carried nowhere and read by nothing.
 */
export interface HookInput {
  toolName: string;
  /** The tool's own arguments, flattened to text — what a policy matches on. */
  toolInput: Record<string, string>;
  sessionId?: string;
  /** The directory the agent is working in, reported by the host. */
  workingDirectory?: string;
  /** Present when the host names the specific call, which joins hook to transcript. */
  toolUseId?: string;
}

/**
 * Null means this payload cannot be ruled on at all — unparseable, or an event this
 * seam was never installed for. It is a configuration fault, never a verdict, so the
 * caller says so on stderr rather than dressing it up as a refusal.
 */
export function readHookInput(raw: string): HookInput | null {
  const payload = asRecord(parse(raw));
  if (payload === null) return null;

  const event = payload['hook_event_name'];
  if (event !== HOOK_EVENT_NAME) return null;

  const toolName = payload['tool_name'];
  if (typeof toolName !== 'string' || toolName.length === 0) return null;

  return {
    toolName,
    toolInput: flatten(payload['tool_input']),
    ...optionalText('sessionId', payload['session_id']),
    ...optionalText('workingDirectory', payload['cwd']),
    ...optionalText('toolUseId', payload['tool_use_id']),
  };
}

function parse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    // A truncated write on stdin is a real state; it is absence, not a crash.
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/** Spread-in rather than assigned, so an absent field never becomes an empty string. */
function optionalText<TKey extends string>(
  key: TKey,
  value: unknown,
): Partial<Record<TKey, string>> {
  if (typeof value !== 'string' || value.length === 0) return {};
  return { [key]: value } as Record<TKey, string>;
}

/** Flattened to strings, which is what a policy matches; structured values as JSON text. */
export function flatten(input: unknown): Record<string, string> {
  const record = asRecord(input);
  if (record === null) return {};

  const flattened: Record<string, string> = {};
  for (const [name, value] of Object.entries(record)) {
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
