import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';

/**
 * The loopback redirect flow (RFC 8252): the CLI listens on a random port on
 * 127.0.0.1, sends the browser to the control plane, and the control plane
 * redirects back with a one-time code once a human has signed in.
 *
 * A code, never a token, crosses in the URL. Query strings reach browser
 * history, referrers and proxy logs; the code is single-use and worthless
 * without the verifier, which never leaves this process.
 */

/** Loopback only. A routable bind would let the network answer the callback. */
const CALLBACK_HOST = '127.0.0.1';
const CALLBACK_PATH = '/callback';
/** Long enough to find a password manager, short enough not to hang a terminal. */
const LOGIN_TIMEOUT_MS = 180_000;

export const LOGIN_TIMED_OUT = 'login_timed_out';

/** How the CLI shows someone a URL. Injected so tests never launch a browser. */
export type BrowserOpener = (url: string) => Promise<void>;

interface BrowserLoginRequest {
  cloudUrl: string;
  open: BrowserOpener;
  /** Overridable so a test does not wait three minutes to prove a timeout. */
  timeoutMs?: number;
}

interface BrowserLoginResult {
  code: string;
  verifier: string;
  redirectUri: string;
}

type BrowserLoginOutcome = BrowserLoginResult | typeof LOGIN_TIMED_OUT;

export function timedOut(
  outcome: BrowserLoginOutcome,
): outcome is typeof LOGIN_TIMED_OUT {
  return outcome === LOGIN_TIMED_OUT;
}

/** RFC 7636 S256. The verifier stays here; only its hash is sent. */
export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = base64Url(randomBytes(32));
  const challenge = base64Url(createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

function base64Url(bytes: Buffer): string {
  return bytes.toString('base64url');
}

/** Constant-time, and length-safe: timingSafeEqual throws on a length mismatch. */
export function statesMatch(expected: string, presented: string | null): boolean {
  if (presented === null || presented.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(presented));
}

/**
 * Opens the browser and resolves once the control plane redirects back.
 *
 * The server is bound before the browser is opened — a callback arriving at a
 * port nothing is listening on is an error a person cannot recover from.
 */
export async function loginThroughBrowser(
  request: BrowserLoginRequest,
): Promise<BrowserLoginOutcome> {
  const state = base64Url(randomBytes(32));
  const { verifier, challenge } = pkcePair();

  const { server, port } = await listen();
  const redirectUri = `http://${CALLBACK_HOST}:${port}${CALLBACK_PATH}`;

  try {
    const waiting = awaitCallback(server, state, request.timeoutMs ?? LOGIN_TIMEOUT_MS);
    await request.open(authorizeUrl(request.cloudUrl, redirectUri, state, challenge));
    const code = await waiting;
    if (code === null) return LOGIN_TIMED_OUT;
    return { code, verifier, redirectUri };
  } finally {
    server.close();
  }
}

export function authorizeUrl(
  cloudUrl: string,
  redirectUri: string,
  state: string,
  challenge: string,
): string {
  const query = new URLSearchParams({
    redirect_uri: redirectUri,
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  });
  return `${cloudUrl}/v1/auth/cli?${query.toString()}`;
}

async function listen(): Promise<{ server: Server; port: number }> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, CALLBACK_HOST, resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('could not bind a loopback port for the sign-in callback');
  }
  return { server, port: (address as AddressInfo).port };
}

/** Resolves with the code, or null when nobody finished signing in. */
function awaitCallback(
  server: Server,
  state: string,
  timeoutMs: number,
): Promise<string | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), timeoutMs);
    timer.unref();

    server.on('request', (incoming, response) => {
      const url = new URL(incoming.url ?? '/', `http://${CALLBACK_HOST}`);
      if (url.pathname !== CALLBACK_PATH) {
        response.writeHead(404).end();
        return;
      }

      // A mismatched state means this callback was not the one we started, so
      // the code in it is somebody else's. Refuse it and keep waiting.
      if (!statesMatch(state, url.searchParams.get('state'))) {
        respond(
          response,
          400,
          'Sign-in could not be verified',
          'You can close this tab and run "memnox login" again.',
        );
        return;
      }

      const error = url.searchParams.get('error');
      const code = url.searchParams.get('code');
      if (error !== null || code === null) {
        respond(
          response,
          400,
          'Sign-in was refused',
          error ?? 'The control plane returned no code.',
        );
        clearTimeout(timer);
        resolve(null);
        return;
      }

      respond(
        response,
        200,
        'Signed in',
        'You can close this tab and go back to your terminal.',
      );
      clearTimeout(timer);
      resolve(code);
    });
  });
}

function respond(
  response: {
    writeHead: (status: number, headers: Record<string, string>) => void;
    end: (body: string) => void;
  },
  status: number,
  title: string,
  detail: string,
): void {
  response.writeHead(status, { 'content-type': 'text/html; charset=utf-8' });
  response.end(
    `<!doctype html><meta charset="utf-8"><title>${title}</title>` +
      '<body style="font:16px system-ui;margin:4rem auto;max-width:30rem;text-align:center">' +
      `<h1 style="font-size:1.3rem">${title}</h1><p style="color:#555">${detail}</p></body>`,
  );
}

/** Opens a URL in the platform browser. Replaced in tests and headless runs. */
export const systemBrowser: BrowserOpener = async (url) => {
  const { spawn } = await import('node:child_process');
  const command =
    process.platform === 'darwin'
      ? 'open'
      : process.platform === 'win32'
        ? 'start'
        : 'xdg-open';
  // Detached and ignored: the browser outliving the CLI is the normal case.
  spawn(command, [url], {
    stdio: 'ignore',
    detached: true,
    shell: process.platform === 'win32',
  }).unref();
};
