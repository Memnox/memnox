import { connect } from 'node:net';

import {
  DAEMON_METHOD,
  decodeResponse,
  encode,
  LineBuffer,
  socketPathFor,
  type DaemonRequest,
  type DaemonResponse,
} from '@memnox/core';

/**
 * The seams' client for the local daemon: one line
 * out, one line back, and null on any failure.
 */

/** One request per connection, so every request can carry the same id. */
const REQUEST_ID = 1;

/** Milliseconds. An interceptor runs on every command; a slow daemon must not be felt. */
export const DAEMON_TIMEOUT_MS = 250;

export interface AskOptions {
  action: string;
  target?: string;
  sessionId?: string;
  timeoutMs?: number;
}

export interface ReportOptions {
  action: string;
  target?: string;
  sessionId?: string;
  /** How the command ended. The breaker's error and progress signals need this. */
  exitCode?: number;
  outOfScope?: boolean;
  /** Only the drift, from a seam that reports nothing else, so nothing is charged. */
  driftOnly?: boolean;
  /** Reported, never estimated. Absent on every surface that cannot know it. */
  costUsd?: number;
  timeoutMs?: number;
}

/**
 * Null on any failure at all: not running, too slow, garbled. The caller then evaluates
 * in process, which is the same rules a little slower.
 */
export function askDaemon(
  home: string,
  options: AskOptions,
): Promise<DaemonResponse | null> {
  return speak(home, options.timeoutMs, {
    id: REQUEST_ID,
    method: DAEMON_METHOD.EVALUATE,
    action: options.action,
    ...(options.target === undefined ? {} : { target: options.target }),
    ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
  });
}

/**
 * What happened, after it happened, because the breaker watches outcomes. Best effort:
 * no daemon means counters are not kept, never that the command is held up.
 */
export function reportToDaemon(
  home: string,
  options: ReportOptions,
): Promise<DaemonResponse | null> {
  return speak(home, options.timeoutMs, {
    id: REQUEST_ID,
    method: DAEMON_METHOD.RECORD,
    action: options.action,
    ...(options.target === undefined ? {} : { target: options.target }),
    ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
    ...(options.exitCode === undefined ? {} : { exitCode: options.exitCode }),
    ...(options.outOfScope === undefined ? {} : { outOfScope: options.outOfScope }),
    ...(options.driftOnly === true ? { driftOnly: true } : {}),
    ...(options.costUsd === undefined ? {} : { costUsd: options.costUsd }),
  });
}

function speak(
  home: string,
  timeout: number | undefined,
  message: DaemonRequest,
): Promise<DaemonResponse | null> {
  const path = socketPathFor(home);

  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: DaemonResponse | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(value);
    };

    const timer = setTimeout(() => finish(null), timeout ?? DAEMON_TIMEOUT_MS);
    timer.unref?.();

    const socket = connect(path, () => {
      socket.write(encode(message));
    });

    const reader = new LineBuffer();
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      for (const line of reader.push(chunk)) finish(decodeResponse(line));
    });
    // A reply the daemon closed on without a newline is still the reply.
    socket.on('end', () => {
      for (const line of reader.push('\n')) finish(decodeResponse(line));
      finish(null);
    });
    // Not running is the ordinary case, and an unanswered close would drain the loop with this pending.
    socket.on('close', () => finish(null));
    socket.on('error', () => finish(null));
  });
}
