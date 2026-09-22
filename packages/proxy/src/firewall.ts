import { spawn, type ChildProcess } from 'node:child_process';
import type {
  EventSink,
  HoldService,
  LocalGate,
  SessionNote,
  SessionNotes,
  SharedActions,
} from '@memnox/core';
import {
  LocalGateAuthorizer,
  SessionLimitedAuthorizer,
  UngovernedAuthorizer,
  type CallAuthorizer,
} from './call-authorizer';
import { DuplicateWorkAuthorizer } from './duplicate-work';
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
  /**
   * The workspace's register of what other agents are about to do, so two machines
   * do not each send the same message. Absent means nothing is asked, which is what
   * a test wants and what an unenrolled machine gets.
   */
  actions?: SharedActions;
  /** The workspace's inbox for this agent. Absent means nothing is collected. */
  notes?: SessionNotes;
}

/** What a claim is filed under when the wrapper was told no agent. */
const UNNAMED_AGENT = 'an agent';

/**
 * The session a claim is filed under when the agent named none.
 *
 * One per proxy process, because an agent starts its own servers for each
 * session it runs. A single shared name made two Claude Code sessions on one
 * laptop the same claimant, and the second was never told the first had it.
 */
function unnamedSession(): string {
  return `ses_proxy_${process.pid}`;
}

/**
 * What this proxy collects notes as: the agent it serves, in the session it was
 * told or the one this process stands for, the same name its claims are filed under.
 */
function notesFor(options: FirewallOptions): { notes?: () => Promise<SessionNote[]> } {
  const inbox = options.notes;
  if (inbox === undefined) return {};
  const agent = options.agent ?? UNNAMED_AGENT;
  const session = options.sessionId ?? unnamedSession();
  return { notes: () => inbox.collect(agent, session) };
}

/** The signals an agent ends its servers with. */
const ENDING_SIGNALS = ['SIGTERM', 'SIGINT', 'SIGHUP'] as const;
const ENDING_SIGNAL_NUMBER: Record<(typeof ENDING_SIGNALS)[number], number> = {
  SIGHUP: 1,
  SIGINT: 2,
  SIGTERM: 15,
};
/** What a process a signal ended reports: 128 plus the signal. */
const SIGNALLED_EXIT_BASE = 128;

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
  private readonly authorizer: CallAuthorizer;

  constructor(private readonly options: FirewallOptions) {
    this.ledger = options.ledger ?? null;
    // stderr is the safe side channel — stdout carries the JSON-RPC stream.
    this.log =
      options.log ?? ((message) => process.stderr.write(`[memnox] ${message}\n`));

    // Built first: it is what gives the session a client to report frames through.
    const authorizer = this.buildAuthorizer();
    this.authorizer = authorizer;

    this.session = new FirewallSession({
      filter: new ToolFilter(options.allowPattern, options.denyPattern, this.log),
      authorizer,
      channel: this.buildChannel(),
      log: this.log,
      server: options.serverName,
      ...(options.hold === undefined ? {} : { hold: options.hold }),
      ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
      ...(options.agent === undefined ? {} : { agent: options.agent }),
      ...notesFor(options),
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
    child.on('exit', (code) => {
      const status = code === null ? 0 : code;
      /* At once where nothing is held, which is every proxy with no workspace:
         the exit code is the wrapped server's and nothing should delay it. */
      if (this.authorizer.close === undefined) return exit(status);
      void this.close().then(() => exit(status));
    });
    /* An agent ends a session by signalling its servers. Whatever this proxy
       still holds is let go first, or the thing it was on reads as busy for the
       rest of its window with nobody working on it. Only for a real process: a
       test that injects its own exit owns its own signals. */
    if (deps.exit === undefined) {
      for (const signal of ENDING_SIGNALS) {
        process.once(signal, () => {
          void this.close().then(() => {
            child.kill(signal);
            exit(SIGNALLED_EXIT_BASE + ENDING_SIGNAL_NUMBER[signal]);
          });
        });
      }
    }

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
    const limited =
      limits === undefined
        ? rules
        : new SessionLimitedAuthorizer(rules, limits, this.options.sessionId);

    /* Outermost, and asked only of what the rules already allowed: an action
       about to be refused needs no claim. */
    const actions = this.options.actions;
    if (actions === undefined) return limited;
    return new DuplicateWorkAuthorizer(
      limited,
      actions,
      {
        agent: this.options.agent ?? UNNAMED_AGENT,
        sessionId: this.options.sessionId ?? unnamedSession(),
        pid: process.pid,
      },
      this.options.serverName,
    );
  }

  /** Lets go of anything held for calls in flight. Never rejects. */
  private async close(): Promise<void> {
    const close = this.authorizer.close;
    if (close === undefined) return;
    await close.call(this.authorizer).catch(() => undefined);
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
