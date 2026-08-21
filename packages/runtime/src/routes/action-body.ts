import type { ActionRequest } from '@memnox/core';

const MAX_SIGNALS = 32;
const MAX_SIGNAL_LENGTH = 120;
/** Fact ids from an earlier answer; a bound, for the same reason signals have one. */
const MAX_READS = 64;
const MAX_READ_LENGTH = 120;

/** `arguments` is dropped here: the raw payload must not cross the network. */
export function readActionRequest(body: unknown): ActionRequest | null {
  if (typeof body !== 'object' || body === null) return null;
  const raw = body as Partial<ActionRequest>;
  if (typeof raw.action !== 'string') return null;

  const { arguments: _payload, signals, reads, ...rest } = raw;
  const accepted = readSignals(signals);
  const relied = readStringList(reads, MAX_READS, MAX_READ_LENGTH);
  return {
    ...rest,
    action: raw.action,
    ...(accepted.length === 0 ? {} : { signals: accepted }),
    ...(relied.length === 0 ? {} : { reads: relied }),
  };
}

function readSignals(value: unknown): string[] {
  return readStringList(value, MAX_SIGNALS, MAX_SIGNAL_LENGTH);
}

function readStringList(value: unknown, maxItems: number, maxLength: number): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === 'string')
    .slice(0, maxItems)
    .map((item) => item.slice(0, maxLength));
}
