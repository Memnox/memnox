import { spawn, type ChildProcess } from 'node:child_process';

import {
  changingTools,
  ENFORCEMENT_MODE,
  exitCodeForSignal,
  serverDownEvent,
  toolArrivalEvent,
  UNNAMED_AGENT,
  UNNAMED_SESSION,
  type EnforcementMode,
  type McpToolDeclaration,
  type PinnedTool,
  type ToolPins,
  type EventSink,
  type HoldService,
  type LocalGate,
  type SessionNote,
  type SessionNotes,
  type SharedActions,
  type UnusualNotice,
} from '@memnox/core';

import {
  LocalGateAuthorizer,
  SessionLimitedAuthorizer,
  StoppedAuthorizer,
  UngovernedAuthorizer,
  type CallAuthorizer,
} from './call-authorizer';
import { DuplicateWorkAuthorizer } from './duplicate-work';
import { FirewallSession, type FirewallChannel } from './firewall-session';
import { LineBuffer } from './json-rpc';
import { ProbationAuthorizer, type ProbationLookup } from './probation-authorizer';
import { recordToLedger, type LedgerContext } from './ledger';
import type { SessionLimits } from './session-limits';
import type { McpCallRecord } from './result-guard';
import type { ToolCall } from './tool-call';
import { ToolFilter } from './tool-filter';
import { ToolManifest } from './tool-manifest';

/**
 * The MCP proxy: an agent's client on one side, its real server on the other, and a
 * verdict on every `tools/call` in between. Everything else is forwarded untouched.
 */

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
   * Where rows go, opened by the caller; absent means
   * no recording, so a test writes to no ledger.
   */
  ledger?: EventSink;
  /** Supplied so a row's time is the caller's to fix in a test. */
  now?: () => Date;
  /**
   * The pause and the budget. Absent means neither
   * is consulted, so nothing here reads a disk.
   */
  limits?: SessionLimits;
  /** True while `memnox stop` holds. Absent means never, so a test reads no disk. */
  stopped?: () => Promise<boolean>;
  /**
   * Holds an ASK for a person. Absent means an ASK
   * is a denial and says so, right for a test only.
   */
  hold?: HoldService;
  /**
   * The workspace's register of what other agents
   * are about to do. Absent means nothing is asked.
   */
  actions?: SharedActions;
  /** The workspace's inbox for this agent. Absent means nothing is collected. */
  notes?: SessionNotes;
  /** Whether this server is still on probation. Absent means it never is. */
  probation?: ProbationLookup;
  /** Where an instruction-shaped result puts the session under suspicion. Absent, nowhere. */
  notice?: UnusualNotice;
  /** What this server listed last time. Absent means no listing is compared. */
  pins?: ToolPins;
  /** The machine's mode, for the row a new tool is recorded under. */
  mode?: EnforcementMode;
}

/**
 * The session a claim is filed under when the agent named
 * none: one per proxy, as agents start servers per session.
 */
function unnamedSession(): string {
  return `ses_proxy_${process.pid}`;
}

/**
 * What this proxy collects notes as: the same
 * agent and session its claims are filed under.
 */
function notesFor(options: FirewallOptions): { notes?: () => Promise<SessionNote[]> } {
  const inbox = options.notes;
  if (inbox === undefined) return {};
  const agent = options.agent ?? UNNAMED_AGENT;
  const session = options.sessionId ?? unnamedSession();
  return { notes: () => inbox.collect(agent, session) };
}

/**
 * The server and tool whose result read like instructions, named so every
 * seam in the session can say which result it is still wary of.
 */
function taintFor(options: FirewallOptions): {
  onInstruction?: (call: ToolCall) => void;
} {
  const notice = options.notice;
  if (notice === undefined) return {};
  return {
    onInstruction: (call) => {
      notice.taint(`${options.serverName}.${call.name}`);
    },
  };
}

/** The signals an agent ends its servers with. */
const ENDING_SIGNALS = ['SIGTERM', 'SIGINT', 'SIGHUP'] as const;

/** How the proxy reaches the process table and the client stream. */
export interface FirewallProcessDeps {
  spawn?: (command: string, args: string[]) => ChildProcess;
  input?: NodeJS.EventEmitter;
  exit?: (code: number) => void;
}

function defaultSpawn(command: string, args: readonly string[]): ChildProcess {
  return spawn(command, args, { stdio: ['pipe', 'pipe', 'inherit'] });
}

/** Owns the child process and two streams; routing belongs to FirewallSession. */
export class McpFirewall {
  private readonly session: FirewallSession;
  private readonly log: (message: string) => void;
  private readonly ledger: EventSink | null;
  private child: ChildProcess | null = null;
  private readonly authorizer: CallAuthorizer;
  /** Set once the agent is ending the session, so its server stopping is not reported. */
  private ending = false;
  /** Filled by the first listing; built before the authorizer, which reads it. */
  private readonly manifest = new ToolManifest();

  constructor(private readonly options: FirewallOptions) {
    this.ledger = options.ledger ?? null;
    // stderr is the safe side channel, because stdout carries the JSON-RPC stream.
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
      ...taintFor(options),
      onListing: (tools) => {
        this.manifest.listed(tools);
        void this.compareListing(tools).catch(() => undefined);
      },
      manifest: this.manifest,
      // Every call reaches the ledger once, when its outcome is known.
      record: (call) => this.write(call),
    });
  }

  /**
   * A tool that changes things and was not there last time is said on stderr and kept as a
   * row, with whether any rule covers it, because a server can grow one between two sessions.
   */
  private async compareListing(tools: readonly McpToolDeclaration[]): Promise<void> {
    const pins = this.options.pins;
    if (pins === undefined) return;
    const change = await pins.compare(this.options.serverName, tools);
    const arrived = changingTools(change);
    if (change.first || arrived.length === 0) return;
    const unruled = arrived.filter((tool) => !this.ruled(tool)).map((tool) => tool.name);
    this.log(
      `${this.options.serverName} now lists ${arrived.map((tool) => tool.name).join(', ')}, which change something outside this machine${unruled.length === 0 ? '' : `, and no rule covers ${unruled.join(', ')}`}`,
    );
    await this.ledger?.append(
      toolArrivalEvent({
        server: this.options.serverName,
        tools: arrived,
        unruled,
        sessionId: this.options.sessionId ?? UNNAMED_SESSION,
        agent: this.options.agent ?? UNNAMED_AGENT,
        at: (this.options.now ?? (() => new Date()))().toISOString(),
        mode: this.options.mode ?? ENFORCEMENT_MODE.ENFORCE,
      }),
    );
  }

  /** Said at once; the row, where there is a ledger, is what the exit waits for. */
  private serverDown(status: number): Promise<void> | null {
    this.log(
      `${this.options.serverName} stopped with exit code ${status}, so every call to it will fail until the agent reconnects`,
    );
    const ledger = this.ledger;
    if (ledger === null) return null;
    return ledger
      .append(
        serverDownEvent({
          server: this.options.serverName,
          exitCode: status,
          sessionId: this.options.sessionId ?? UNNAMED_SESSION,
          agent: this.options.agent ?? UNNAMED_AGENT,
          at: (this.options.now ?? (() => new Date()))().toISOString(),
          mode: this.options.mode ?? ENFORCEMENT_MODE.ENFORCE,
        }),
      )
      .catch(() => undefined);
  }

  /** Whether any rule speaks to a call of this tool, under either name the seams use. */
  private ruled(tool: PinnedTool): boolean {
    const gate = this.options.gate;
    if (gate === undefined) return false;
    return [`mcp.${tool.name}`, `mcp.${this.options.serverName}.${tool.name}`].some(
      (action) =>
        gate.evaluate({ action, target: this.options.serverName, toolClass: tool.class })
          .matchedPolicies.length > 0,
    );
  }

  /**
   * One row per call, written once the verdict is
   * applied, so a failure loses a row and nothing else.
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
   * Replay the session after the row, since the breaker counts what happened. Not awaited
   * and never rejecting: the pause is read before the next call anyway.
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

  /**
   * Spawn, stream, and exit are parameters, and this class's only ambient dependencies.
   */
  start(deps: FirewallProcessDeps = {}): void {
    const [executable, ...args] = this.options.command;
    if (!executable) throw new Error('firewall requires a server command to wrap');

    const exit = deps.exit ?? ((code: number) => process.exit(code));
    const child = (deps.spawn ?? defaultSpawn)(executable, args);
    this.child = child;
    child.on('exit', (code) => {
      const status = code === null ? 0 : code;
      const finish = (): void => {
        // At once where nothing is held, since the exit code is the wrapped server's.
        if (this.authorizer.close === undefined) return exit(status);
        void this.close().then(() => exit(status));
      };
      // A server that dies under a working agent is said, since everything using it now fails.
      if (status === 0 || this.ending) return finish();
      const row = this.serverDown(status);
      if (row === null) return finish();
      void row.then(finish);
    });
    // A test that injects its own exit owns its own signals.
    if (deps.exit === undefined) this.releaseOnSignals(child, exit);
    this.pipeClient(deps.input ?? process.stdin, child);
    this.pipeServer(child);
  }

  /**
   * An agent ends a session by signalling its
   * servers, so whatever is held is let go first.
   */
  private releaseOnSignals(child: ChildProcess, exit: (code: number) => void): void {
    for (const signal of ENDING_SIGNALS) {
      process.once(signal, () => {
        // The agent ended it, so the server stopping is not news.
        this.ending = true;
        void this.close().then(() => {
          child.kill(signal);
          exit(exitCodeForSignal(signal));
        });
      });
    }
  }

  private pipeClient(input: NodeJS.EventEmitter, child: ChildProcess): void {
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
  }

  private pipeServer(child: ChildProcess): void {
    // Piped stdio always gives both pipes; null means the spawn contract changed.
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
    const chain = this.buildChain();
    const stopped = this.options.stopped;
    return stopped === undefined ? chain : new StoppedAuthorizer(chain, stopped);
  }

  private buildChain(): CallAuthorizer {
    const gate = this.options.gate;
    const rules =
      gate === undefined
        ? new UngovernedAuthorizer()
        : new LocalGateAuthorizer(
            gate,
            this.options.serverName,
            this.options.sessionId,
            this.manifest,
          );
    const probation = this.options.probation;
    const judged =
      probation === undefined
        ? rules
        : new ProbationAuthorizer(rules, this.options.serverName, probation);

    // Outside the rules, so a pause and a spent budget hold with no policy file too.
    const limits = this.options.limits;
    const limited =
      limits === undefined
        ? judged
        : new SessionLimitedAuthorizer(judged, limits, this.options.sessionId);

    // Outermost, and asked only of what the rules already allowed.
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
