import { createServer, type Server, type Socket } from 'node:net';
import { chmod, mkdir, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  ACTOR_TYPE,
  CircuitBreaker,
  DAEMON_METHOD,
  DECISION_EFFECT,
  describePause,
  encode,
  decodeRequest,
  LineReader,
  SessionLimits,
  SessionPauses,
  ENFORCEMENT_MODE,
  EVENT_SCHEMA_VERSION,
  EVENT_SURFACE,
  exhaustedBy,
  socketPathFor,
  TOOL_CLASS,
  ViolationMemory,
  type BreakerBreach,
  type Budget,
  type FleetSpend,
  type MemnoxEvent,
  type DaemonRequest,
  type DaemonResponse,
  type LocalGate,
  type SessionPause,
} from '@memnox/core';

interface DaemonDeps {
  gate?: LocalGate;
  limits?: SessionLimits;
  violations?: ViolationMemory;
  breaker?: CircuitBreaker;
  /** Where a pause is written, so every seam in the session sees it. */
  pauses?: SessionPauses;
  budgets?: readonly Budget[];
  /** What the rest of the fleet has spent, as of the last heartbeat. */
  fleetSpend?: readonly FleetSpend[];
  /**
   * What has already been spent today, read from the ledger once at startup. Without
   * it a daily budget resets whenever the daemon does, which is a budget anybody can
   * clear by killing a process.
   */
  spentAlready?: readonly MemnoxEvent[];
  now?: () => string;
  log: (message: string) => void;
}

/**
 * One process holding the rules, so an interceptor pays a connect rather than a file
 * read on every command. Nothing here is required: an interceptor that cannot reach
 * the daemon evaluates in process instead, which is slower and exactly as strict.
 */
/** The shorter of the two platform limits, so one number is right on both. */
const SOCKET_PATH_LIMIT = 103;

export class MemnoxDaemon {
  private readonly limits: SessionLimits;
  private readonly violations: ViolationMemory;
  private readonly breaker: CircuitBreaker;
  private readonly pauses: SessionPauses | null;
  /** Read once per answer rather than per session, so the hot path stays a map lookup. */
  private readonly held = new Map<string, SessionPause>();
  /** Charged as they happen, on top of what the ledger already held at startup. */
  private readonly charged: MemnoxEvent[] = [];
  private server: Server | null = null;

  constructor(private readonly deps: DaemonDeps) {
    this.limits = deps.limits ?? new SessionLimits();
    this.violations = deps.violations ?? new ViolationMemory();
    this.breaker = deps.breaker ?? new CircuitBreaker();
    this.pauses = deps.pauses ?? null;
  }

  async listen(home: string): Promise<string> {
    const path = socketPathFor(home);
    /* A unix socket path is capped by the kernel — 104 bytes on macOS, 108 on Linux —
       and over it `listen` fails with EADDRINUSE, which sends somebody hunting for a
       process that does not exist. Named here, because the fix is a shorter home. */
    if (Buffer.byteLength(path) > SOCKET_PATH_LIMIT) {
      throw new Error(
        `The daemon's socket path is ${Buffer.byteLength(path)} bytes and the kernel allows ${SOCKET_PATH_LIMIT}:\n  ${path}\n` +
          'Use a shorter home directory. The interceptors still evaluate in process, which is the same rules.',
      );
    }
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
    if (request.method === DAEMON_METHOD.RECORD) return this.record(request);
    if (request.method === DAEMON_METHOD.STATUS) {
      return this.heldResponse(request) ?? { id: request.id, ok: true };
    }
    if (request.method === DAEMON_METHOD.EVALUATE) return this.evaluate(request);
    return { id: request.id, ok: true };
  }

  /**
   * What happened, after it happened. The breaker watches outcomes, so this is the
   * only place any of its signals can be counted — a request on its own cannot say
   * whether the same command has now failed eleven times.
   */
  private record(request: DaemonRequest): DaemonResponse {
    const sessionId = request.sessionId ?? 'ses_local';
    const action = request.action ?? 'unknown';
    const now = (this.deps.now ?? (() => new Date().toISOString()))();

    const breach = this.breaker.observe({
      sessionId,
      fingerprint: `${action}:${request.target ?? ''}`,
      action,
      at: now,
      failed: request.exitCode !== undefined && request.exitCode !== 0,
      ...(request.exitCode === undefined
        ? {}
        : { failureKind: String(request.exitCode) }),
      ...(request.outOfScope === undefined ? {} : { outOfScope: request.outOfScope }),
      ...(request.costUsd === undefined ? {} : { costUsd: request.costUsd }),
    });
    if (breach !== null) this.hold(sessionId, breach, action, now);

    /* Only what actually ran is charged. An action the rules refused never reached a
       terminal, so charging for it would let a strict policy exhaust the budget it
       was protecting. */
    if (request.exitCode === undefined || request.exitCode === 0) {
      this.charge(sessionId, action, now);
    }
    return { id: request.id, ok: true };
  }

  /** A row shaped like the ledger's, so one domain counts both halves the same way. */
  private charge(sessionId: string, action: string, now: string): void {
    this.charged.push({
      id: `evt_daemon_${this.charged.length}`,
      schemaVersion: EVENT_SCHEMA_VERSION,
      at: now,
      sessionId,
      agent: 'an agent',
      actorType: ACTOR_TYPE.AGENT,
      surface: EVENT_SURFACE.SHELL,
      operation: action,
      class: TOOL_CLASS.UNKNOWN,
      effect: DECISION_EFFECT.ALLOW,
      mode: ENFORCEMENT_MODE.ENFORCE,
      reason: 'charged against a budget',
    });
  }

  /** Held in memory and on disk: the seams are other processes and have to see it. */
  private hold(
    sessionId: string,
    breach: BreakerBreach,
    lastAction: string,
    now: string,
  ): void {
    if (this.held.has(sessionId)) return;
    const pause: SessionPause = {
      sessionId,
      signal: breach.signal,
      reason: breach.reason,
      reached: breach.reached,
      ceiling: breach.ceiling,
      pausedAt: now,
      lastAction,
    };
    this.held.set(sessionId, pause);
    this.deps.log(`paused ${sessionId}: ${breach.reason}`);
    void this.pauses?.pause(pause).catch((err: unknown) => {
      // A pause that could not be written still holds here; say so rather than lose it.
      this.deps.log(`could not write the pause: ${String(err)}`);
    });
  }

  /** Non-null when this session is held. Shaped as a refusal an agent can read. */
  private heldResponse(request: DaemonRequest): DaemonResponse | null {
    const pause = this.held.get(request.sessionId ?? 'ses_local');
    if (pause === undefined) return null;
    return {
      id: request.id,
      ok: true,
      effect: DECISION_EFFECT.DENY,
      reason: describePause(pause),
      paused: { signal: pause.signal, reason: pause.reason },
    };
  }

  /** Lifts a hold, so `memnox resume` reaches the daemon that is enforcing it. */
  resume(sessionId: string): boolean {
    return this.held.delete(sessionId);
  }

  private evaluate(request: DaemonRequest): DaemonResponse {
    const action = request.action;
    if (action === undefined) {
      return { id: request.id, ok: false, error: 'evaluate needs an action' };
    }
    const now = (this.deps.now ?? (() => new Date().toISOString()))();
    const sessionId = request.sessionId ?? 'ses_local';

    /* A held session runs nothing, whatever the rules say. Checked first because a
       pause is about the session and not about this one call. */
    const paused = this.heldResponse(request);
    if (paused !== null) return paused;

    /* An allowance that has run out stops the action before the rules are consulted,
       and says so in those words: "not allowed" and "no allowance left until tomorrow"
       lead to different fixes, and confusing them sends somebody editing rules. */
    const budgets = this.deps.budgets ?? [];
    if (budgets.length > 0) {
      const spent = exhaustedBy(
        budgets,
        action,
        [...(this.deps.spentAlready ?? []), ...this.charged],
        now,
        sessionId,
        1,
        undefined,
        this.deps.fleetSpend ?? [],
      );
      if (spent !== null) {
        return {
          id: request.id,
          ok: true,
          effect: DECISION_EFFECT.DENY,
          reason: spent.reason,
          limit: `budget:${spent.budget.name}`,
        };
      }
    }

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
