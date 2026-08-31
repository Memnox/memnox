import { existsSync, statSync, unlinkSync } from 'node:fs';
import { createServer, request as httpRequest, type IncomingMessage } from 'node:http';
import type { ServerResponse } from 'node:http';
import { DockerSeam, DOCKER_BLIND_SPOTS } from './docker-seam';
import { buildAuthorizer, log } from './seam-runtime';
import {
  DOCKER_REAL_SOCKET,
  DOCKER_SEAM_SOCKET,
  DOCKER_SOCKET_PATH_LIMIT,
} from './tool-hook.constants';

const REFUSED_STATUS = 403;

const USAGE = `Usage: memnox-docker [--socket <path>] [--upstream <path>]

Sits in front of the Docker socket. Point a client at it:

  DOCKER_HOST=unix://${DOCKER_SEAM_SOCKET} <your agent>

Blind to:
${DOCKER_BLIND_SPOTS.map((spot) => `  ${spot}`).join('\n')}`;

function flag(argv: readonly string[], name: string, fallback: string): string {
  const index = argv.indexOf(name);
  if (index === -1) return fallback;
  return argv[index + 1] ?? fallback;
}

/** A stale socket from a killed run would refuse to bind and read as a broken install. */
function clearStaleSocket(path: string): void {
  if (!existsSync(path)) return;
  try {
    unlinkSync(path);
  } catch (err) {
    log(`could not clear the old socket at ${path}: ${String(err)}`);
  }
}

/** Present and actually a socket, which is the only proof the bind took. */
function isSocket(path: string): boolean {
  try {
    return statSync(path).isSocket();
  } catch {
    return false;
  }
}

function refuse(response: ServerResponse, message: string): void {
  response.writeHead(REFUSED_STATUS, { 'content-type': 'application/json' });
  // Docker clients print `message`, so the reason reaches the person at the keyboard.
  response.end(JSON.stringify({ message: `Memnox withheld this: ${message}` }));
}

/** Forwarded unchanged onto the real socket; this seam rules, it never edits. */
function forward(
  request: IncomingMessage,
  response: ServerResponse,
  upstreamPath: string,
): void {
  const upstream = httpRequest(
    {
      socketPath: upstreamPath,
      path: request.url,
      method: request.method,
      headers: request.headers,
    },
    (answer) => {
      response.writeHead(answer.statusCode ?? 502, answer.headers);
      answer.pipe(response);
    },
  );
  upstream.on('error', (err: unknown) => {
    log(`docker socket unreachable: ${String(err)}`);
    response.writeHead(502).end();
  });
  request.pipe(upstream);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes('--help')) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }

  const socketPath = flag(argv, '--socket', DOCKER_SEAM_SOCKET);
  const upstreamPath = flag(argv, '--upstream', DOCKER_REAL_SOCKET);
  const seam = new DockerSeam({ authorizer: await buildAuthorizer() });

  const server = createServer((request, response) => {
    void (async () => {
      const path = request.url;
      const method = request.method;
      if (path === undefined || method === undefined) {
        return refuse(response, 'no request');
      }

      const outcome = await seam.gate({ method, path });
      if (!outcome.allowed) {
        log(`withheld ${outcome.action} (${method} ${path}): ${outcome.message ?? ''}`);
        return refuse(response, outcome.message ?? 'no reason recorded');
      }
      forward(request, response, upstreamPath);
    })();
  });

  /* A unix socket path is capped by the operating system, and a path over the cap
     binds nothing while `listen` still reports success — which would leave this seam
     announcing coverage it does not have. That is the one lie worth crashing over. */
  if (Buffer.byteLength(socketPath) > DOCKER_SOCKET_PATH_LIMIT) {
    log(
      `socket path is ${Buffer.byteLength(socketPath)} bytes, over the ${DOCKER_SOCKET_PATH_LIMIT}-byte limit — pass a shorter --socket`,
    );
    process.exitCode = 1;
    return;
  }

  server.on('error', (err: unknown) => {
    log(`could not bind ${socketPath}, ruling on nothing: ${String(err)}`);
    process.exitCode = 1;
  });

  clearStaleSocket(socketPath);
  server.listen(socketPath, () => {
    // Bound is not believed until the socket is on disk: nothing may claim to
    // govern until a client actually has somewhere to connect.
    if (!isSocket(socketPath)) {
      log(`listen reported success but ${socketPath} is not there — ruling on nothing`);
      process.exitCode = 1;
      server.close();
      return;
    }
    log(`docker seam on ${socketPath}, forwarding to ${upstreamPath}`);
    for (const spot of DOCKER_BLIND_SPOTS) log(`blind to: ${spot}`);
  });

  // Leaving the socket behind would block the next run from binding it.
  const close = (): void => {
    server.close(() => clearStaleSocket(socketPath));
  };
  process.on('SIGINT', close);
  process.on('SIGTERM', close);
}

main().catch((err: unknown) => {
  log(`docker seam failed to start, ruling on nothing: ${String(err)}`);
  process.exitCode = 1;
});
