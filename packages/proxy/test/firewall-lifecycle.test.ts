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

/** One frame as two Buffers, cut between the bytes of its emoji. */
function splitInsideEmoji(): [Buffer, Buffer] {
  const frame = Buffer.from(
    '{"jsonrpc":"2.0","id":1,"method":"x","params":{"t":"🎉"}}\n',
  );
  const cut = frame.indexOf(Buffer.from('🎉')) + 2;
  return [frame.subarray(0, cut), frame.subarray(cut)];
}

describe('the process the firewall wraps', () => {
  const build = () => {
    const { child, stdinEnded, written } = fakeChild();
    const input = new EventEmitter();
    const exits: number[] = [];
    const sent: string[] = [];
    const firewall = new McpFirewall({
      command: ['node', 'server.js'],
      serverName: 'demo',
      log: () => {},
    });
    firewall.start({
      spawn: () => child,
      input,
      exit: (code) => exits.push(code),
      output: (payload) => sent.push(payload),
    });
    return { input, stdinEnded, written, exits, child, sent };
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

  it('keeps a character the client split across two chunks whole', () => {
    const { input, written } = build();
    const [first, second] = splitInsideEmoji();

    input.emit('data', first);
    input.emit('data', second);

    expect(written.join('')).toContain('🎉');
    expect(written.join('')).not.toContain('\uFFFD');
  });

  it('keeps a character the server split across two chunks whole', () => {
    const { child, sent } = build();
    const [first, second] = splitInsideEmoji();

    child.stdout?.emit('data', first);
    child.stdout?.emit('data', second);

    expect(sent.join('')).toContain('🎉');
    expect(sent.join('')).not.toContain('\uFFFD');
  });

  it('exits with the code the wrapped server exited with', () => {
    const { child, exits } = build();

    child.emit('exit', 3);

    expect(exits).toEqual([3]);
  });
});
