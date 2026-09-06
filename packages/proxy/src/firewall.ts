import { spawn, type ChildProcess } from 'node:child_process';
import type { EventSink, HoldService, LocalGate } from '@memnox/core';
import {
  LocalGateAuthorizer,
  SessionLimitedAuthorizer,
  UngovernedAuthorizer,
  type CallAuthorizer,
} from './call-authorizer';
import { FirewallSession, type FirewallChannel } from './firewall-session';
import { LineBuffer } from './json-rpc';
import { recordToLedger, type LedgerContext } from './ledger';
import type { SessionLimits } from './session-limits';
import type { McpCallRecord } from './result-guard';
import { ToolFilter } from './tool-filter';

export interface FirewallOptions {
  /** The wrapped MCP server, e.g. ["npx", "-y", "@some/mcp-server"]. */
  command: string[];
  serverName: string;
  allowPattern?: string;
  denyPattern?: string;
  /** Groups this proxy's calls in the audit timeline. */
  sessionId?: string;
  /** Loading is the caller's job because it reads files; see loadLocalGate. */
  gate?: LocalGate;
  log?: (message: string) => void;
  /** The MCP client this wraps, for the row. Never a credential. */
  agent?: string;
  /**
   * Where rows go. Opening it reads a disk, so it is the caller's job for the same
   * reason the gate is — and absent means no recording, so a test writes nothing to
   * the developer's own ledger by forgetting.
   */
  ledger?: EventSink;
  /** Supplied so a row's time is the caller's to fix in a test. */
  now?: () => Date;
  /**
   * The pause and the budget. Absent means neither is consulted, which is what a
   * test wants and what an embedder without a `~/.memnox` gets — the same bargain
   * as `gate` and `ledger`, so nothing here reads a disk on its own.
   */
  limits?: SessionLimits;
  /**
   * Holds an ASK for a person. Absent means an ASK is a denial and says so, which is
   * right for a test and wrong for a wrapped server: without one, every `ask` rule an
   * MCP call hits is a refusal nobody was ever offered the chance to answer.
   */
  hold?: HoldService;
}

/** How the proxy reaches the process table and the client stream. */
export interface FirewallProcessDeps {
  spawn?: (command: string, args: string[]) => ChildProcess;
  input?: NodeJS.EventEmitter;
  exit?: (code: number) => void;
}

const defaultSpawn = (command: string, args: string[]): ChildProcess =>
  spawn(command, args, { stdio: ['pipe', 'pipe', 'inherit'] });

/** Owns the child process and two streams; routing belongs to FirewallSession. */
export class McpFirewall {
  private readonly session: FirewallSession;
  private readonly log: (message: string) => void;
  private readonly ledger: EventSink | null;
  private child: ChildProcess | null = null;

  constructor(private readonly options: FirewallOptions) {
    this.ledger = options.ledger ?? null;
    // stderr is the safe side channel — stdout carries the JSON-RPC stream.
    this.log =
      options.log ?? ((message) => process.stderr.write(`[memnox] ${message}\n`));

    // Built first: it is what gives the session a client to report frames through.
    const authorizer = this.buildAuthorizer();

    this.session = new FirewallSession({
      filter: new ToolFilter(options.allowPattern, options.denyPattern, this.log),
      authorizer,
      channel: this.buildChannel(),
      log: this.log,
      server: options.serverName,
      ...(options.hold === undefined ? {} : { hold: options.hold }),
      ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
      ...(options.agent === undefined ? {} : { agent: options.agent }),
      // Every call reaches the ledger once, when its outcome is known.
      record: (call) => this.write(call),
    });
  }

  /**
   * One row per call, written where the verdict is already applied so a failure here
   * can only lose a row — never a decision, and never the JSON-RPC stream.
   */
  private write(call: McpCallRecord): void {
    const sink = this.ledger;
    const now = this.options.now ?? (() => new Date());
    if (sink !== null) {
      recordToLedger(sink, call, now().toISOString(), this.ledgerContext);
    }
    this.observe();
  }

  /**
   * Replay the session now that this call's outcome is known.
   *
   * After the row rather than before it, because the breaker counts what happened:
   * "the same tool failed eleven times" is only true once the eleventh has
   * returned. This is the half that was missing entirely — the proxy wrote its
   * outcomes to the same ledger the breaker replays and nothing ever replayed
   * them, so a loop that never touched a shell ran until somebody noticed.
   *
   * Not awaited, and never allowed to reject: the verdict is already applied and
   * the JSON-RPC stream is not worth interrupting for a pause that will be read
   * before the next call anyway.
   */
  private observe(): void {
    const limits = this.options.limits;
    const sessionId = this.options.sessionId;
    if (limits === undefined || sessionId === undefined || sessionId === '') return;
    void limits.observe(sessionId).catch(() => undefined);
  }

  private get ledgerContext(): LedgerContext {
    return {
      ...(this.options.sessionId === undefined
        ? {}
        : { sessionId: this.options.sessionId }),
      ...(this.options.agent === undefined ? {} : { agent: this.options.agent }),
    };
  }

  /** Spawn, stream, and exit are parameters — this class's only ambient dependencies. */
  start(deps: FirewallProcessDeps = {}): void {
    const [executable, ...args] = this.options.command;
    if (!executable) throw new Error('firewall requires a server command to wrap');

    const spawnChild = deps.spawn ?? defaultSpawn;
    const input = deps.input ?? process.stdin;
    const exit = deps.exit ?? ((code: number) => process.exit(code));

    const child = spawnChild(executable, args);
    this.child = child;
    child.on('exit', (code) => exit(code === null ? 0 : code));

    const clientToServer = new LineBuffer();
    input.on('data', (chunk: Buffer) => {
      for (const line of clientToServer.push(chunk.toString('utf8'))) {
        void this.session.fromClient(line);
      }
    });

    // Without forwarding the close, the child never sees an end and stays resident.
    input.on('end', () => {
      const stdin = child.stdin;
      if (stdin !== null) stdin.end();
    });

    // stdio: ['pipe','pipe',…] always gives us both pipes; a null here means the
    // spawn contract changed and nothing would ever reach the client.
    if (child.stdout === null) {
      throw new Error('firewall could not attach to the wrapped server output');
    }
    const serverToClient = new LineBuffer();
    child.stdout.on('data', (chunk: Buffer) => {
      for (const line of serverToClient.push(chunk.toString('utf8'))) {
        this.session.fromServer(line);
      }
    });
  }

  private buildAuthorizer(): CallAuthorizer {
    const gate = this.options.gate;
    const rules =
      gate === undefined
        ? new UngovernedAuthorizer()
        : new LocalGateAuthorizer(gate, this.options.serverName, this.options.sessionId);

    /* Outside the rules, so a pause and a spent budget hold on a machine with no
       policy file too: neither is a statement about what is allowed. */
    const limits = this.options.limits;
    if (limits === undefined) return rules;
    return new SessionLimitedAuthorizer(rules, limits, this.options.sessionId);
  }

  private buildChannel(): FirewallChannel {
    return {
      toServer: (payload) => {
        const child = this.child;
        if (child === null) return false;

        const stdin = child.stdin;
        if (stdin === null) return false;

        // `writable` distinguishes a dead pipe from ordinary backpressure, which
        // write() also reports as false but Node buffers for us.
        if (!stdin.writable) return false;

        stdin.write(payload);
        return true;
      },
      toClient: (payload) => process.stdout.write(payload),
    };
  }
}
