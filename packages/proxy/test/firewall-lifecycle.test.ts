import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { describe, expect, it } from 'vitest';
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
