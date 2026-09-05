import { connect } from 'node:net';
import {
  DAEMON_METHOD,
  decodeResponse,
  encode,
  LineReader,
  socketPathFor,
  type DaemonResponse,
} from '@memnox/core';

/** Milliseconds. An interceptor runs on every command; a slow daemon must not be felt. */
export const DAEMON_TIMEOUT_MS = 250;

export interface AskOptions {
  action: string;
  target?: string;
  sessionId?: string;
  timeoutMs?: number;
}

/**
 * Null on any failure at all — not running, too slow, garbled. The caller then
 * evaluates in process, which is the same rules a little slower. A daemon that could
 * fail open would be a gate that stops working when it is under load.
 */
export function askDaemon(
  home: string,
  options: AskOptions,
): Promise<DaemonResponse | null> {
  const path = socketPathFor(home);
  const timeoutMs = options.timeoutMs ?? DAEMON_TIMEOUT_MS;

  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: DaemonResponse | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(value);
    };

    const timer = setTimeout(() => finish(null), timeoutMs);
    timer.unref?.();

    const socket = connect(path, () => {
      socket.write(
        encode({
          id: 1,
          method: DAEMON_METHOD.EVALUATE,
          action: options.action,
          ...(options.target === undefined ? {} : { target: options.target }),
          ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
        }),
      );
    });

    const reader = new LineReader();
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      for (const line of reader.push(chunk)) finish(decodeResponse(line));
    });
    // Not running is the ordinary case, not an error worth printing.
    socket.on('error', () => finish(null));
  });
}
