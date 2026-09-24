/**
 * A line-delimited JSON protocol over a Unix socket, kept small because an interceptor
 * asks on every command an agent types, so asking has to cost a connect and one line.
 */
import { join } from 'node:path';
import { MEMNOX_HOME } from '../config/config';
import type { DecisionEffect } from '../constants/decision.constants';

export const SOCKET_FILE = 'memnox.sock';

export function socketPathFor(home: string): string {
  return join(home, MEMNOX_HOME, SOCKET_FILE);
}

export const DAEMON_METHOD = {
  /** Rule on one action. The hot path, and the only one with a latency budget. */
  EVALUATE: 'evaluate',
  /** Ask a person, through whatever terminal the daemon owns. */
  HOLD: 'hold',
  /** Record how a command ended, so a session is one timeline and the breaker can count outcomes. */
  RECORD: 'record',
  /** Whether this session is held, asked before anything runs. */
  STATUS: 'status',
  /** Liveness, for `memnox doctor`. */
  PING: 'ping',
} as const;

export type DaemonMethod = (typeof DAEMON_METHOD)[keyof typeof DAEMON_METHOD];

export interface DaemonRequest {
  id: number;
  method: DaemonMethod;
  sessionId?: string;
  agent?: string;
  action?: string;
  target?: string;
  /** A digest. Arguments never travel, not even over a local socket. */
  argsDigest?: string;
  reason?: string;
  /** On RECORD: how the command ended. The breaker's error and progress signals. */
  exitCode?: number;
  /** On RECORD: whether it fell outside the declared task. */
  outOfScope?: boolean;
  /** On RECORD: what it cost, when a surface can report one. Never estimated. */
  costUsd?: number;
}

export interface DaemonResponse {
  id: number;
  ok: boolean;
  effect?: DecisionEffect;
  reason?: string;
  alternative?: { action: string; resource?: string; note: string };
  /** Set when a limit stopped this rather than a rule. */
  limit?: string;
  /** Set when the breaker held the session. Different from a denial, and said so. */
  paused?: { signal: string; reason: string };
  error?: string;
}

export function encode(message: DaemonRequest | DaemonResponse): string {
  return `${JSON.stringify(message)}\n`;
}

/** Null rather than a throw: a garbled line is a bad client, not a crash. */
export function decodeRequest(line: string): DaemonRequest | null {
  const message = parseMessage<DaemonRequest>(line);
  if (message === null || typeof message.method !== 'string') return null;
  // The id and method are checked; the rest is optional by the protocol's own shape.
  return message as DaemonRequest;
}

export function decodeResponse(line: string): DaemonResponse | null {
  const message = parseMessage<DaemonResponse>(line);
  // Only the id is required; every other field of a response is optional.
  return message === null ? null : (message as DaemonResponse);
}

/** An object carrying a numeric id, or null for anything else, including a line that is not JSON. */
function parseMessage<T extends { id: number }>(line: string): Partial<T> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  // Narrowed field by field by the callers, starting with the id here.
  const message = parsed as Partial<T>;
  return typeof message.id === 'number' ? message : null;
}
