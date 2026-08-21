import { homedir } from 'node:os';
import { MemnoxClient, type HttpTransport } from '@memnox/sdk';
import { readAgentConfig } from './agent-config';
import { ConsoleOutput, type CliOutput } from './cli-output';
import {
  isConnectionRefused,
  resolveConnection,
  RuntimeUnreachableError,
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

/** Everything a command needs from outside itself, so nothing reaches for `console`. */
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
      fetch: this.addressed(options.url),
    });
  }

  /** The only layer that still knows which address was dialled. */
  private addressed(url: string): HttpTransport {
    const send = this.transport ?? ((target, init) => fetch(target, init));
    return async (target, init) => {
      try {
        return await send(target, init);
      } catch (err) {
        if (isConnectionRefused(err))
          throw new RuntimeUnreachableError(url, { cause: err });
        throw err;
      }
    };
  }

  /** Flags, then environment, then what `memnox setup` stored. */
  async connect(flags: ConnectionFlags): Promise<ConnectedClient> {
    const connection = resolveConnection(flags, await this.readStored(), this.env);
    return { client: this.client(connection), connection };
  }
}
