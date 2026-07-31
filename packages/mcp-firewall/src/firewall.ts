import { spawn, type ChildProcess } from 'node:child_process';
import type { LocalGate } from '@memnox/local-gate';
import { MemnoxClient } from '@memnox/sdk';
import {
  LayeredAuthorizer,
  LocalGateAuthorizer,
  RuntimeAuthorizer,
  UngovernedAuthorizer,
  type CallAuthorizer,
} from './call-authorizer';
import { FirewallSession, type FirewallChannel } from './firewall-session';
import { LineBuffer } from './json-rpc';
import { ToolFilter } from './tool-filter';

export interface FirewallOptions {
  /** The wrapped MCP server, e.g. ["npx", "-y", "@some/mcp-server"]. */
  command: string[];
  serverName: string;
  /** Memnox runtime; omit to run with static tool filters only. */
  runtimeUrl?: string;
  agentToken?: string;
  allowPattern?: string;
  denyPattern?: string;
  /** Forward calls when the runtime is unreachable. Default false — a firewall fails closed. */
  failOpen?: boolean;
  /** Groups this proxy's calls in the audit timeline. */
  sessionId?: string;
  /**
   * Rules evaluated in this process, against the call's own arguments. Loading
   * is the caller's job because it reads files; see loadLocalGate.
   */
  gate?: LocalGate;
  log?: (message: string) => void;
}

/**
 * Transparent stdio MCP proxy. Owns only the child process and the two byte
 * streams; every routing decision belongs to the FirewallSession it drives.
 */
export class McpFirewall {
  private readonly session: FirewallSession;
  private readonly log: (message: string) => void;
  private child: ChildProcess | null = null;

  constructor(private readonly options: FirewallOptions) {
    // stderr is the safe side channel — stdout carries the JSON-RPC stream.
    this.log =
      options.log ?? ((message) => process.stderr.write(`[memnox] ${message}\n`));

    this.session = new FirewallSession({
      filter: new ToolFilter(options.allowPattern, options.denyPattern, this.log),
      authorizer: this.buildAuthorizer(),
      channel: this.buildChannel(),
      log: this.log,
    });
  }

  start(): void {
    const [executable, ...args] = this.options.command;
    if (!executable) throw new Error('firewall requires a server command to wrap');

    const child = spawn(executable, args, { stdio: ['pipe', 'pipe', 'inherit'] });
    this.child = child;
    child.on('exit', (code) => process.exit(code === null ? 0 : code));

    const clientToServer = new LineBuffer();
    process.stdin.on('data', (chunk: Buffer) => {
      for (const line of clientToServer.push(chunk.toString('utf8'))) {
        void this.session.fromClient(line);
      }
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
    const { runtimeUrl, agentToken, gate } = this.options;
    const local =
      gate === undefined
        ? null
        : new LocalGateAuthorizer(gate, this.options.serverName, this.options.sessionId);

    if (!runtimeUrl || !agentToken) return local ?? new UngovernedAuthorizer();

    const runtime = new RuntimeAuthorizer(
      new MemnoxClient({ baseUrl: runtimeUrl, token: agentToken }),
      {
        serverName: this.options.serverName,
        sessionId: this.options.sessionId,
        failOpen: this.options.failOpen,
        log: this.log,
      },
    );
    return local === null ? runtime : new LayeredAuthorizer(local, runtime);
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
