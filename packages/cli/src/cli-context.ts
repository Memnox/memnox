import { homedir } from 'node:os';
import { MemnoxClient, type HttpTransport } from '@memnox/sdk';
import { readAgentConfig } from './agent-config';
import { ConsoleOutput, type CliOutput } from './cli-output';
import {
  resolveConnection,
  type ConnectionFlags,
  type ResolvedConnection,
  type StoredConfigReader,
} from './connection';
import { resolveStyle, type Style } from './style';

/** The runtime connection flags every client-backed command accepts. */
interface ConnectionOptions {
  url: string;
  token?: string;
  adminToken?: string;
}

interface ConnectedClient {
  client: MemnoxClient;
  connection: ResolvedConnection;
}

/**
 * Everything a command needs from outside itself. Commands take this instead of
 * reaching for `console` or building their own client, so a test swaps the whole
 * outside world in one object.
 *
 * Styling and stored credentials live here because both are how a command talks
 * to the outside — the context stays output and HTTP, and does not widen into a
 * grab bag of things only one command needs.
 */
export class CliContext {
  constructor(
    readonly out: CliOutput = new ConsoleOutput(),
    private readonly transport?: HttpTransport,
    readonly style: Style = resolveStyle(process.env, process.stdout.isTTY === true),
    private readonly readStored: StoredConfigReader = () => readAgentConfig(homedir()),
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {}

  client(options: ConnectionOptions): MemnoxClient {
    return new MemnoxClient({
      baseUrl: options.url,
      token: options.token,
      adminToken: options.adminToken,
      fetch: this.transport,
    });
  }

  /**
   * Builds a client from flags, falling back to the environment and then to the
   * token `memnox setup` stored. Returns the resolved connection too, so a
   * command can report which runtime it reached and where the token came from.
   */
  async connect(flags: ConnectionFlags): Promise<ConnectedClient> {
    const connection = resolveConnection(flags, await this.readStored(), this.env);
    return { client: this.client(connection), connection };
  }
}
