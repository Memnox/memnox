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
  LineBuffer,
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
  UNNAMED_AGENT,
  UNNAMED_SESSION,
} from '@memnox/core';

/**
 * The daemon: one process holding the rules, so a seam pays a connect rather than a file
 * read per command. Optional, because every seam falls back to evaluating in process.
 */

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
  /** Spent today, read from the ledger at startup, or killing the daemon clears a budget. */
  spentAlready?: readonly MemnoxEvent[];
  now?: () => string;
  log: (message: string) => void;
}

/** The shorter of the two platform limits, so one number is right on both. */
const SOCKET_PATH_LIMIT = 103;
const SOCKET_DIR_MODE = 0o700;
const SOCKET_MODE = 0o600;

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
    // Over the kernel's cap `listen` fails with EADDRINUSE, which sends somebody hunting
    // for a process that does not exist, so the real cause is named here.
    if (Buffer.byteLength(path) > SOCKET_PATH_LIMIT) {
      throw new Error(
        `The daemon's socket path is ${Buffer.byteLength(path)} bytes and the kernel allows ${SOCKET_PATH_LIMIT}:\n  ${path}\n` +
          'Use a shorter home directory. The interceptors still evaluate in process, which is the same rules.',
      );
    }
    await mkdir(dirname(path), { recursive: true, mode: SOCKET_DIR_MODE });
    // A stale socket from a killed daemon would refuse every connection.
    await rm(path, { force: true });

    const server = createServer((socket) => this.serve(socket));
    this.server = server;

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(path, () => resolve());
    });
    // Owner only, because anything that can talk to this socket can ask about your rules.
    await chmod(path, SOCKET_MODE);
    return path;
  }

  async close(): Promise<void> {
    const server = this.server;
    if (server === null) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    this.server = null;
  }

  /** Lifts a hold, so `memnox resume` reaches the daemon that is enforcing it. */
  resume(sessionId: string): boolean {
    return this.held.delete(sessionId);
  }

  private serve(socket: Socket): void {
    const reader = new LineBuffer();
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

  private now(): string {
    return this.deps.now?.() ?? new Date().toISOString();
  }

  /**
   * What happened, after it happened. The breaker watches outcomes, so this is the only
   * place its signals can be counted.
   */
  private record(request: DaemonRequest): DaemonResponse {
    const sessionId = request.sessionId ?? UNNAMED_SESSION;
    const action = request.action ?? 'unknown';
    const now = this.now();

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
    if (breach !== null) this.hold({ sessionId, breach, lastAction: action, now });

    // Only what ran is charged, or a strict policy would exhaust the budget it protects.
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
      agent: UNNAMED_AGENT,
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
  private hold(input: HoldInput): void {
    const { sessionId, breach, lastAction, now } = input;
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
    const pause = this.held.get(request.sessionId ?? UNNAMED_SESSION);
    if (pause === undefined) return null;
    return {
      id: request.id,
      ok: true,
      effect: DECISION_EFFECT.DENY,
      reason: describePause(pause),
      paused: { signal: pause.signal, reason: pause.reason },
    };
  }

  /** Pause, then budget, then limits, then rules: each stops the call before the next is asked. */
  private evaluate(request: DaemonRequest): DaemonResponse {
    const action = request.action;
    if (action === undefined) {
      return { id: request.id, ok: false, error: 'evaluate needs an action' };
    }
    const call: EvaluatedCall = {
      request,
      action,
      now: this.now(),
      sessionId: request.sessionId ?? UNNAMED_SESSION,
    };
    return (
      this.heldResponse(request) ??
      this.budgetRefusal(call) ??
      this.limitRefusal(call) ??
      this.ruleVerdict(call)
    );
  }

  /** "No allowance left" and "not allowed" lead to different fixes, so a spent budget says so. */
  private budgetRefusal(call: EvaluatedCall): DaemonResponse | null {
    const budgets = this.deps.budgets ?? [];
    if (budgets.length === 0) return null;
    const spent = exhaustedBy(budgets, {
      action: call.action,
      events: [...(this.deps.spentAlready ?? []), ...this.charged],
      now: call.now,
      sessionId: call.sessionId,
      fleet: this.deps.fleetSpend ?? [],
    });
    if (spent === null) return null;
    return {
      id: call.request.id,
      ok: true,
      effect: DECISION_EFFECT.DENY,
      reason: spent.reason,
      limit: `budget:${spent.budget.name}`,
    };
  }

  /** A session already past its ceiling is stopped whatever the rules say about this call. */
  private limitRefusal(call: EvaluatedCall): DaemonResponse | null {
    const fingerprint = `${call.action}:${call.request.target ?? ''}`;
    const breach = this.limits.record(call.sessionId, fingerprint, call.now);
    if (breach === null) return null;
    return {
      id: call.request.id,
      ok: true,
      effect: DECISION_EFFECT.DENY,
      reason: breach.reason,
      limit: breach.kind,
    };
  }

  private ruleVerdict(call: EvaluatedCall): DaemonResponse {
    const { request, action } = call;
    const gate = this.deps.gate;
    if (gate === undefined) {
      return {
        id: request.id,
        ok: true,
        effect: DECISION_EFFECT.ALLOW,
        reason: 'no rules configured',
      };
    }
    const target = request.target === undefined ? {} : { target: request.target };
    const verdict = gate.evaluate({ action, ...target });
    if (verdict.effect === DECISION_EFFECT.ALLOW) {
      return { id: request.id, ok: true, effect: verdict.effect, reason: verdict.reason };
    }

    const seen = this.violations.record({ action, at: call.now, ...target });
    const repeated = this.violations.isRepeated(action, request.target)
      ? ` (asked ${seen} times now, so the rule may not match how this work is done)`
      : '';
    return {
      id: request.id,
      ok: true,
      effect: verdict.effect,
      reason: `${verdict.reason}${repeated}`,
      ...(verdict.alternative === undefined ? {} : { alternative: verdict.alternative }),
    };
  }
}

interface HoldInput {
  sessionId: string;
  breach: BreakerBreach;
  lastAction: string;
  now: string;
}

/** One evaluate request, with the defaults every step would otherwise resolve again. */
interface EvaluatedCall {
  request: DaemonRequest;
  action: string;
  now: string;
  sessionId: string;
}
