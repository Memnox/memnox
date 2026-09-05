import { connect } from 'node:net';
import { mkdtemp, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DAEMON_METHOD,
  DECISION_EFFECT,
  encode,
  decodeResponse,
  LineReader,
  LocalGate,
  SessionLimits,
  socketPathFor,
  type DaemonRequest,
  type DaemonResponse,
} from '@memnox/core';
import { MemnoxDaemon } from '../src/daemon-server';

const NOW = '2026-09-05T10:00:00.000Z';

function gate(): LocalGate {
  return new LocalGate(
    [
      {
        name: 'no-force-push',
        match: { actions: ['git.push'] },
        decision: {
          effect: DECISION_EFFECT.DENY,
          reason: 'history is shared',
          alternative: { action: 'git.push', resource: 'a branch', note: 'open a PR' },
        },
      } as never,
    ],
    { agentName: 'claude-code' },
  );
}

/** One connection, one request, one answer — exactly what an interceptor does. */
function ask(path: string, request: DaemonRequest): Promise<DaemonResponse> {
  return new Promise((resolve, reject) => {
    const socket = connect(path, () => socket.write(encode(request)));
    const reader = new LineReader();
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      for (const line of reader.push(chunk)) {
        const response = decodeResponse(line);
        socket.end();
        if (response === null) return reject(new Error(`unreadable: ${line}`));
        return resolve(response);
      }
    });
    socket.on('error', reject);
  });
}

async function running(
  deps: Partial<ConstructorParameters<typeof MemnoxDaemon>[0]> = {},
) {
  const home = await mkdtemp(join(tmpdir(), 'memnox-daemon-'));
  const daemon = new MemnoxDaemon({ now: () => NOW, log: () => {}, ...deps });
  await daemon.listen(home);
  return { home, daemon, path: socketPathFor(home) };
}

describe('the daemon', () => {
  it('answers a ping', async () => {
    const { daemon, path } = await running();
    expect(await ask(path, { id: 1, method: DAEMON_METHOD.PING })).toMatchObject({
      id: 1,
      ok: true,
    });
    await daemon.close();
  });

  it('keeps its socket owner-only, because anything that reaches it reads your rules', async () => {
    const { daemon, path } = await running();
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    await daemon.close();
  });

  it('rules on an action, carrying the alternative back', async () => {
    const { daemon, path } = await running({ gate: gate() });
    const response = await ask(path, {
      id: 2,
      method: DAEMON_METHOD.EVALUATE,
      action: 'git.push',
      target: 'main',
    });

    expect(response.effect).toBe(DECISION_EFFECT.DENY);
    expect(response.reason).toContain('history is shared');
    expect(response.alternative?.action).toBe('git.push');
    await daemon.close();
  });

  it('allows what no rule covers', async () => {
    const { daemon, path } = await running({ gate: gate() });
    const response = await ask(path, {
      id: 3,
      method: DAEMON_METHOD.EVALUATE,
      action: 'git.status',
    });
    expect(response.effect).toBe(DECISION_EFFECT.ALLOW);
    await daemon.close();
  });

  it('stops a session past its limit, whatever the rules would have said', async () => {
    const limits = new SessionLimits({
      runtimeMinutes: 0,
      toolCalls: 1,
      repeatedAction: 0,
    });
    const { daemon, path } = await running({ gate: gate(), limits });

    await ask(path, { id: 4, method: DAEMON_METHOD.EVALUATE, action: 'git.status' });
    const second = await ask(path, {
      id: 5,
      method: DAEMON_METHOD.EVALUATE,
      action: 'git.status',
    });

    expect(second.effect).toBe(DECISION_EFFECT.DENY);
    expect(second.limit).toBe('tool-calls');
    await daemon.close();
  });

  it('says when the same refusal has come round again', async () => {
    const { daemon, path } = await running({ gate: gate() });
    for (const id of [6, 7]) {
      await ask(path, { id, method: DAEMON_METHOD.EVALUATE, action: 'git.push' });
    }
    const third = await ask(path, {
      id: 8,
      method: DAEMON_METHOD.EVALUATE,
      action: 'git.push',
    });

    expect(third.reason).toContain('asked 3 times now');
    expect(third.reason).toContain('may not match how this work is done');
    await daemon.close();
  });

  it('answers a garbled line rather than dropping the connection', async () => {
    const { daemon, path } = await running();
    const response = await new Promise<DaemonResponse>((resolve, reject) => {
      const socket = connect(path, () => socket.write('not json\n'));
      const reader = new LineReader();
      socket.setEncoding('utf8');
      socket.on('data', (chunk: string) => {
        for (const line of reader.push(chunk)) {
          socket.end();
          const parsed = decodeResponse(line);
          if (parsed === null) return reject(new Error('unreadable'));
          return resolve(parsed);
        }
      });
      socket.on('error', reject);
    });

    expect(response.ok).toBe(false);
    expect(response.error).toContain('understand');
    await daemon.close();
  });

  it('replaces a stale socket left by a killed daemon', async () => {
    const { home, daemon } = await running();
    await daemon.close();

    const second = new MemnoxDaemon({ log: () => {} });
    await expect(second.listen(home)).resolves.toContain('memnox.sock');
    await second.close();
  });
});
