import { MemnoxClient, type HttpTransport } from '@memnox/sdk';
import { ConsoleOutput, type CliOutput } from './cli-output';

/** The runtime connection flags every client-backed command accepts. */
interface ConnectionOptions {
  url: string;
  token?: string;
  adminToken?: string;
}

/**
 * Everything a command needs from outside itself. Commands take this instead of
 * reaching for `console` or building their own client, so a test swaps the whole
 * outside world in one object.
 */
export class CliContext {
  constructor(
    readonly out: CliOutput = new ConsoleOutput(),
    private readonly transport?: HttpTransport,
  ) {}

  client(options: ConnectionOptions): MemnoxClient {
    return new MemnoxClient({
      baseUrl: options.url,
      token: options.token,
      adminToken: options.adminToken,
      fetch: this.transport,
    });
  }
}
