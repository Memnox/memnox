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

  const stdin = {
    writable: true,
    write: (payload: string) => {
      written.push(payload);
      return true;
    },
    end: () => {
      ended = true;
    },
  };

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
});
