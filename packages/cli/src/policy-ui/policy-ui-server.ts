import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { PolicyUiHandler, PolicyUiRequest } from './policy-ui-app';
import { CONTENT_TYPE, MAX_REQUEST_BYTES, POLICY_UI_HOST } from './policy-ui.constants';

export interface PolicyUiSession {
  readonly url: string;
  /** Resolves when the server stops — what keeps `memnox policy ui` in the foreground. */
  readonly finished: Promise<void>;
  stop(): Promise<void>;
}

/** How the editor gets a socket. Injected so tests drive the handler without binding one. */
export type PolicyUiLauncher = (
  handle: PolicyUiHandler,
  port: number,
) => Promise<PolicyUiSession>;

const PAYLOAD_TOO_LARGE = 413;

/** Node gives repeated headers as an array; the editor only ever reads single values. */
function singleValueHeaders(
  incoming: IncomingMessage['headers'],
): Record<string, string | undefined> {
  const headers: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries(incoming)) {
    headers[name] = Array.isArray(value) ? value[0] : value;
  }
  return headers;
}

/** Resolves with null once the request has sent more than the cap allows. */
function readBody(request: IncomingMessage): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_REQUEST_BYTES) {
        resolve(null);
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}

/** A routable bind would expose an unauthenticated rule editor. */
export const loopbackPolicyUi: PolicyUiLauncher = async (handle, port) => {
  const server = createServer((incoming, outgoing) => {
    void (async () => {
      try {
        const body = await readBody(incoming);
        if (body === null) {
          outgoing.writeHead(PAYLOAD_TOO_LARGE, { 'content-type': CONTENT_TYPE.TEXT });
          outgoing.end('request too large');
          return;
        }
        const request: PolicyUiRequest = {
          method: incoming.method ?? 'GET',
          url: incoming.url ?? '/',
          headers: singleValueHeaders(incoming.headers),
          body,
        };
        const result = await handle(request);
        outgoing.writeHead(result.status, result.headers);
        outgoing.end(result.body);
      } catch (err) {
        // The handler already reports what it can; a socket-level failure has
        // nowhere else to go, and a hung tab is worse than a 500.
        outgoing.writeHead(500, { 'content-type': CONTENT_TYPE.TEXT });
        outgoing.end(err instanceof Error ? err.message : String(err));
      }
    })();
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, POLICY_UI_HOST, resolve);
  });

  const address = server.address();
  if (address === null || typeof address === 'string') {
    server.close();
    throw new Error('could not bind a loopback port for the policy editor');
  }

  const finished = new Promise<void>((resolve) => server.once('close', () => resolve()));

  return {
    url: `http://${POLICY_UI_HOST}:${(address as AddressInfo).port}`,
    finished,
    stop: async () => {
      // A browser tab holds its connection open; without this, close() waits for it.
      server.closeAllConnections();
      server.close();
      await finished;
    },
  };
};
