import type { ActionRequest } from '@memnox/core';

const MAX_SIGNALS = 32;
const MAX_SIGNAL_LENGTH = 120;

/**
 * Shapes an action request off the wire. Two fields get special treatment:
 *
 * - `arguments` is dropped. It is the raw payload of the call, matched by the
 *   in-process gate on the machine that makes it; accepting it here would
 *   quietly reopen the path that design exists to close.
 * - `signals` is the local gate's testimony, so it is bounded before it is
 *   believed — a caller must not be able to write the audit log by the megabyte.
 *
 * Null means the body is not an action request at all.
 */
export function readActionRequest(body: unknown): ActionRequest | null {
  if (typeof body !== 'object' || body === null) return null;
  const raw = body as Partial<ActionRequest>;
  if (typeof raw.action !== 'string') return null;

  const { arguments: _payload, signals, ...rest } = raw;
  const accepted = readSignals(signals);
  return {
    ...rest,
    action: raw.action,
    ...(accepted.length === 0 ? {} : { signals: accepted }),
  };
}

function readSignals(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((signal): signal is string => typeof signal === 'string')
    .slice(0, MAX_SIGNALS)
    .map((signal) => signal.slice(0, MAX_SIGNAL_LENGTH));
}
