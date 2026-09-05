import { createServer, type Server, type Socket } from 'node:net';
import { chmod, mkdir, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  DAEMON_METHOD,
  DECISION_EFFECT,
  encode,
  decodeRequest,
  LineReader,
  SessionLimits,
  socketPathFor,
  ViolationMemory,
  type DaemonRequest,
  type DaemonResponse,
  type LocalGate,
} from '@memnox/core';

interface DaemonDeps {
  gate?: LocalGate;
  limits?: SessionLimits;
  violations?: ViolationMemory;
  now?: () => string;
  log: (message: string) => void;
}

/**
 * One process holding the rules, so an interceptor pays a connect rather than a file
 * read on every command. Nothing here is required: an interceptor that cannot reach
 * the daemon evaluates in process instead, which is slower and exactly as strict.
 */
export class MemnoxDaemon {
  private readonly limits: SessionLimits;
  private readonly violations: ViolationMemory;
  private server: Server | null = null;

  constructor(private readonly deps: DaemonDeps) {
    this.limits = deps.limits ?? new SessionLimits();
    this.violations = deps.violations ?? new ViolationMemory();
  }

  async listen(home: string): Promise<string> {
    const path = socketPathFor(home);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    // A stale socket from a killed daemon would refuse every connection.
    await rm(path, { force: true });

    const server = createServer((socket) => this.serve(socket));
    this.server = server;

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(path, () => resolve());
    });
    // Owner-only: anything that can talk to this socket can ask about your rules.
    await chmod(path, 0o600);
    return path;
  }

  async close(): Promise<void> {
    const server = this.server;
    if (server === null) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    this.server = null;
  }

  private serve(socket: Socket): void {
    const reader = new LineReader();
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      for (const line of reader.push(chunk)) {
        socket.write(encode(this.answer(line)));
      }
    });
    socket.on('error', (err) => {
      // A client that hung up mid-write is ordinary; it must never take the daemon down.
      this.deps.log(`client dropped: ${String(err)}`);
    });
  }

  private answer(line: string): DaemonResponse {
    const request = decodeRequest(line);
    if (request === null) {
      return { id: 0, ok: false, error: 'not a request this daemon understands' };
    }
    if (request.method === DAEMON_METHOD.PING) return { id: request.id, ok: true };
    if (request.method === DAEMON_METHOD.EVALUATE) return this.evaluate(request);
    return { id: request.id, ok: true };
  }

  private evaluate(request: DaemonRequest): DaemonResponse {
    const action = request.action;
    if (action === undefined) {
      return { id: request.id, ok: false, error: 'evaluate needs an action' };
    }
    const now = (this.deps.now ?? (() => new Date().toISOString()))();
    const sessionId = request.sessionId ?? 'ses_local';

    /* Limits are counted before the rules are consulted: a session already past its
       ceiling is stopped whatever the rules would have said about this one call. */
    const breach = this.limits.record(
      sessionId,
      `${action}:${request.target ?? ''}`,
      now,
    );
    if (breach !== null) {
      return {
        id: request.id,
        ok: true,
        effect: DECISION_EFFECT.DENY,
        reason: breach.reason,
        limit: breach.kind,
      };
    }

    const gate = this.deps.gate;
    if (gate === undefined) {
      return {
        id: request.id,
        ok: true,
        effect: DECISION_EFFECT.ALLOW,
        reason: 'no rules configured',
      };
    }

    const verdict = gate.evaluate({
      action,
      ...(request.target === undefined ? {} : { target: request.target }),
    });

    if (verdict.effect !== DECISION_EFFECT.ALLOW) {
      const seen = this.violations.record({
        action,
        at: now,
        ...(request.target === undefined ? {} : { target: request.target }),
      });
      const repeated = this.violations.isRepeated(action, request.target)
        ? ` (asked ${seen} times now — the rule may not match how this work is done)`
        : '';
      return {
        id: request.id,
        ok: true,
        effect: verdict.effect,
        reason: `${verdict.reason}${repeated}`,
        ...(verdict.alternative === undefined
          ? {}
          : { alternative: verdict.alternative }),
      };
    }

    return {
      id: request.id,
      ok: true,
      effect: verdict.effect,
      reason: verdict.reason,
    };
  }
}
