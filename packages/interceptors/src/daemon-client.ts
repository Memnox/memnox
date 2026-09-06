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

export interface ReportOptions {
  action: string;
  target?: string;
  sessionId?: string;
  /** How the command ended. The breaker's error and progress signals need this. */
  exitCode?: number;
  outOfScope?: boolean;
  /** Reported, never estimated. Absent on every surface that cannot know it. */
  costUsd?: number;
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
  return speak(home, options.timeoutMs, {
    id: 1,
    method: DAEMON_METHOD.EVALUATE,
    action: options.action,
    ...(options.target === undefined ? {} : { target: options.target }),
    ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
  });
}

/**
 * What happened, after it happened.
 *
 * The breaker watches outcomes, so without this every one of its signals counts
 * nothing: a request on its own cannot say whether the same command has now failed
 * eleven times. Best effort, like everything else here — a daemon that is not running
 * means the counters are not kept, not that the command is held up.
 */
export function reportToDaemon(
  home: string,
  options: ReportOptions,
): Promise<DaemonResponse | null> {
  return speak(home, options.timeoutMs, {
    id: 1,
    method: DAEMON_METHOD.RECORD,
    action: options.action,
    ...(options.target === undefined ? {} : { target: options.target }),
    ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
    ...(options.exitCode === undefined ? {} : { exitCode: options.exitCode }),
    ...(options.outOfScope === undefined ? {} : { outOfScope: options.outOfScope }),
    ...(options.costUsd === undefined ? {} : { costUsd: options.costUsd }),
  });
}

/** Whether this session is held. One connect, asked before anything runs. */
export function askStatus(
  home: string,
  sessionId: string,
  timeoutMs?: number,
): Promise<DaemonResponse | null> {
  return speak(home, timeoutMs, {
    id: 1,
    method: DAEMON_METHOD.STATUS,
    sessionId,
  });
}

function speak(
  home: string,
  timeout: number | undefined,
  message: Parameters<typeof encode>[0],
): Promise<DaemonResponse | null> {
  const path = socketPathFor(home);
  const timeoutMs = timeout ?? DAEMON_TIMEOUT_MS;

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
      socket.write(encode(message));
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
