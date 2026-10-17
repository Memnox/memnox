import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { FileToolPins, type ToolPins } from '@memnox/core';
import { McpFirewall } from '../src/firewall';

/** A child process, reduced to the three things the proxy actually touches. */
function fakeChild(): {
  child: ChildProcess;
  stdinEnded: () => boolean;
  written: string[];
} {
  const emitter = new EventEmitter();
  const written: string[] = [];
  let ended = false;

  const stdin = Object.assign(new EventEmitter(), {
    writable: true,
    write: (payload: string) => {
      written.push(payload);
      return true;
    },
    end: () => {
      ended = true;
    },
  });

  const child = Object.assign(emitter, {
    stdin,
    stdout: new EventEmitter(),
  }) as unknown as ChildProcess;

  return { child, stdinEnded: () => ended, written };
}

describe('the process the firewall wraps', () => {
  const build = () => {
    const { child, stdinEnded, written } = fakeChild();
    const input = new EventEmitter();
    const exits: number[] = [];
    const firewall = new McpFirewall({
      command: ['node', 'server.js'],
      serverName: 'demo',
      log: () => {},
    });
    firewall.start({ spawn: () => child, input, exit: (code) => exits.push(code) });
    return { input, stdinEnded, written, exits, child };
  };

  it('ends the child stdin when the client closes its own', () => {
    const { input, stdinEnded } = build();
    expect(stdinEnded()).toBe(false);

    input.emit('end');

    expect(stdinEnded()).toBe(true);
  });

  it('forwards a line the client sent before that', () => {
    const { input, written } = build();

    input.emit('data', Buffer.from('{"jsonrpc":"2.0","id":1,"method":"ping"}\n'));

    expect(written.join('')).toContain('"method":"ping"');
  });

  it('exits with the code the wrapped server exited with', () => {
    const { child, exits } = build();

    child.emit('exit', 3);

    expect(exits).toEqual([3]);
  });

  it('exits as a shell would when a signal killed the wrapped server', () => {
    const { child, exits } = build();

    child.emit('exit', null, 'SIGKILL');

    expect(exits).toEqual([137]);
  });

  it('says a server that could not start and exits 127, once', () => {
    const { child } = fakeChild();
    const logged: string[] = [];
    const exits: number[] = [];
    const firewall = new McpFirewall({
      command: ['nodee', 'server.js'],
      serverName: 'demo',
      log: (message) => logged.push(message),
    });
    firewall.start({
      spawn: () => child,
      input: new EventEmitter(),
      exit: (code) => exits.push(code),
    });

    child.emit(
      'error',
      Object.assign(new Error('spawn nodee ENOENT'), { code: 'ENOENT' }),
    );
    child.emit('exit', -2);

    expect(exits).toEqual([127]);
    expect(logged.join('\n')).toContain('could not start demo: spawn nodee ENOENT');
  });

  it('survives a broken pipe and stops writing to it, so the call is refused as server gone', async () => {
    const { child, written } = fakeChild();
    const input = new EventEmitter();
    const logged: string[] = [];
    const firewall = new McpFirewall({
      command: ['node', 'server.js'],
      serverName: 'demo',
      log: (message) => logged.push(message),
    });
    firewall.start({ spawn: () => child, input, exit: () => undefined });

    child.stdin?.emit(
      'error',
      Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }),
    );
    input.emit('data', Buffer.from('{"jsonrpc":"2.0","id":7,"method":"ping"}\n'));
    await new Promise((resolve) => setImmediate(resolve));

    expect(written).toEqual([]);
    expect(logged.join('\n')).toContain('not accepting input; dropped');
  });
});

/* A server may page its tools/list with nextCursor, and each page was taken for the
   whole listing: page two wiped page one from the manifest, and the pin file only ever
   held the last page, so every new session announced the other page as just arrived. */
describe('a tools/list that comes in pages', () => {
  const PAGE_ONE = [{ name: 'read_file' }, { name: 'delete_repo' }];
  const PAGE_TWO = [{ name: 'list_issues' }, { name: 'merge_pull_request' }];

  function session(pins: ToolPins, log: (message: string) => void = () => undefined) {
    const { child } = fakeChild();
    const input = new EventEmitter();
    const firewall = new McpFirewall({
      command: ['node', 'server.js'],
      serverName: 'github',
      log,
      pins,
    });
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    firewall.start({ spawn: () => child, input, exit: () => undefined });
    const fromClient = (message: unknown): void =>
      void input.emit('data', Buffer.from(`${JSON.stringify(message)}\n`, 'utf8'));
    const fromServer = (message: unknown): void =>
      void (child.stdout as unknown as EventEmitter).emit(
        'data',
        Buffer.from(`${JSON.stringify(message)}\n`, 'utf8'),
      );
    const listBothPages = async (): Promise<void> => {
      fromClient({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
      fromServer({
        jsonrpc: '2.0',
        id: 1,
        result: { tools: PAGE_ONE, nextCursor: 'p2' },
      });
      fromClient({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/list',
        params: { cursor: 'p2' },
      });
      fromServer({ jsonrpc: '2.0', id: 2, result: { tools: PAGE_TWO } });
      // The comparison is not awaited by the session; let it land.
      await new Promise((resolve) => setImmediate(resolve));
    };
    return { listBothPages, restore: () => spy.mockRestore() };
  }

  it('compares the pins once, with every tool from every page', async () => {
    const seen: string[][] = [];
    const pins: ToolPins = {
      compare: async (_server, tools) => {
        seen.push(tools.map((tool) => tool.name));
        return { first: true, added: [], removed: [] };
      },
    };
    const { listBothPages, restore } = session(pins);
    try {
      await listBothPages();
    } finally {
      restore();
    }
    expect(seen).toEqual([
      ['read_file', 'delete_repo', 'list_issues', 'merge_pull_request'],
    ]);
  });

  /** The real pin file, with every comparison it was asked for awaitable, so the test
      waits for the disk rather than for a clock. */
  function settling(inner: ToolPins): { pins: ToolPins; settled: () => Promise<void> } {
    const pending: Promise<unknown>[] = [];
    const pins: ToolPins = {
      compare: (server, tools) => {
        const compared = inner.compare(server, tools);
        pending.push(compared);
        return compared;
      },
    };
    const settled = async (): Promise<void> => {
      await Promise.all(pending);
      // The arrival is logged in the continuation after the comparison resolves.
      await new Promise((resolve) => setImmediate(resolve));
    };
    return { pins, settled };
  }

  it('announces nothing new to a second session over the same two pages', async () => {
    const home = await mkdtemp(join(tmpdir(), 'memnox-pins-'));
    const logged: string[] = [];
    for (const _ of [1, 2]) {
      const { pins, settled } = settling(new FileToolPins(home));
      const { listBothPages, restore } = session(pins, (line) => logged.push(line));
      try {
        await listBothPages();
        await settled();
      } finally {
        restore();
      }
    }
    expect(logged.filter((line) => line.includes('now lists'))).toEqual([]);
    await rm(home, { recursive: true, force: true });
  });
});
