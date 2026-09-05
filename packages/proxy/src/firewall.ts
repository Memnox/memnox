import { spawn, type ChildProcess } from 'node:child_process';
import type { EventSink, LocalGate } from '@memnox/core';
import {
  LocalGateAuthorizer,
  UngovernedAuthorizer,
  type CallAuthorizer,
} from './call-authorizer';
import { FirewallSession, type FirewallChannel } from './firewall-session';
import { LineBuffer } from './json-rpc';
import { recordToLedger, type LedgerContext } from './ledger';
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
    if (sink === null) return;
    const now = this.options.now ?? (() => new Date());
    recordToLedger(sink, call, now().toISOString(), this.ledgerContext);
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
    if (gate === undefined) return new UngovernedAuthorizer();
    return new LocalGateAuthorizer(gate, this.options.serverName, this.options.sessionId);
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
