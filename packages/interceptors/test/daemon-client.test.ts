import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { socketPathFor } from '@memnox/core';
import { askDaemon, reportToDaemon } from '../src/daemon-client';

// Long enough that a hang is caught by the assertion rather than passing by timing out to null.
const PATIENT_MS = 10_000;

const homes: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((done) => server.close(() => done()))),
  );
  await Promise.all(
    homes.splice(0).map((home) => rm(home, { recursive: true, force: true })),
  );
});

async function home(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'mx-dc-'));
  homes.push(dir);
  return dir;
}

async function daemon(dir: string, onRequest: (socket: Socket) => void): Promise<void> {
  const path = socketPathFor(dir);
  await mkdir(dirname(path), { recursive: true });
  const server = createServer((socket) => {
    socket.once('data', () => onRequest(socket));
  });
  servers.push(server);
  await new Promise<void>((done) => server.listen(path, done));
}

describe('the daemon client', () => {
  it('resolves to null when the daemon ends the connection without replying', async () => {
    const dir = await home();
    await daemon(dir, (socket) => socket.end());

    const started = Date.now();
    const answer = await reportToDaemon(dir, {
      action: 'shell.run',
      exitCode: 3,
      timeoutMs: PATIENT_MS,
    });

    expect(answer).toBeNull();
    expect(Date.now() - started).toBeLessThan(PATIENT_MS);
  });

  it('reads a reply that closes without a trailing newline', async () => {
    const dir = await home();
    await daemon(dir, (socket) => socket.end(JSON.stringify({ id: 1, ok: true })));

    const answer = await askDaemon(dir, { action: 'git.push', timeoutMs: PATIENT_MS });

    expect(answer).toEqual({ id: 1, ok: true });
  });

  it('resolves to null when there is no socket file', async () => {
    const dir = await home();

    const answer = await askDaemon(dir, { action: 'git.push', timeoutMs: PATIENT_MS });

    expect(answer).toBeNull();
  });
});
