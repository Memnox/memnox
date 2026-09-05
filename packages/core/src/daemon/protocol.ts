import { join } from 'node:path';
import { MEMNOX_HOME } from '../config/config';
import type { DecisionEffect } from '../constants/decision.constants';

/**
 * A line-delimited JSON protocol over a Unix socket. Deliberately small: an
 * interceptor runs on every command an agent types, so the cost of asking has to be a
 * connect and one line, and anything richer would be a reason to stop asking.
 */
export const SOCKET_FILE = 'memnox.sock';

export function socketPathFor(home: string): string {
  return join(home, MEMNOX_HOME, SOCKET_FILE);
}

export const DAEMON_METHOD = {
  /** Rule on one action. The hot path, and the only one with a latency budget. */
  EVALUATE: 'evaluate',
  /** Ask a person, through whatever terminal the daemon owns. */
  HOLD: 'hold',
  /** Record what happened, so a session is one timeline. */
  RECORD: 'record',
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
}

export interface DaemonResponse {
  id: number;
  ok: boolean;
  effect?: DecisionEffect;
  reason?: string;
  alternative?: { action: string; resource?: string; note: string };
  /** Set when a limit stopped this rather than a rule. */
  limit?: string;
  error?: string;
}

export function encode(message: DaemonRequest | DaemonResponse): string {
  return `${JSON.stringify(message)}\n`;
}

/** Null rather than a throw: a garbled line is a bad client, not a crash. */
export function decodeRequest(line: string): DaemonRequest | null {
  try {
    const parsed: unknown = JSON.parse(line);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const message = parsed as Partial<DaemonRequest>;
    if (typeof message.id !== 'number' || typeof message.method !== 'string') return null;
    return message as DaemonRequest;
  } catch {
    // Not JSON. The caller answers with an error rather than dropping the connection.
    return null;
  }
}

export function decodeResponse(line: string): DaemonResponse | null {
  try {
    const parsed: unknown = JSON.parse(line);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const message = parsed as Partial<DaemonResponse>;
    if (typeof message.id !== 'number') return null;
    return message as DaemonResponse;
  } catch {
    return null;
  }
}

/** Splits a socket stream into whole lines; a partial write is normal on a pipe. */
export class LineReader {
  private pending = '';

  push(chunk: string): string[] {
    this.pending += chunk;
    const lines = this.pending.split('\n');
    this.pending = lines.pop() ?? '';
    return lines.filter((line) => line.trim() !== '');
  }
}
