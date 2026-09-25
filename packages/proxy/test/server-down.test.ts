import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import type { MemnoxEvent } from '@memnox/core';
import { McpFirewall } from '../src/firewall';

function fakeChild(): ChildProcess {
  const stdin = { writable: true, write: () => true, end: () => undefined };
  return Object.assign(new EventEmitter(), {
    stdin,
    stdout: new EventEmitter(),
  }) as unknown as ChildProcess;
}

async function exited(code: number): Promise<{ rows: MemnoxEvent[]; logged: string[] }> {
  const rows: MemnoxEvent[] = [];
  const logged: string[] = [];
  const child = fakeChild();
  const done = new Promise<void>((resolve) => {
    const firewall = new McpFirewall({
      command: ['node', 'server.js'],
      serverName: 'railway',
      log: (message) => logged.push(message),
      ledger: {
        append: async (row: MemnoxEvent) => {
          rows.push(row);
        },
      } as never,
    });
    firewall.start({
      spawn: () => child,
      input: new EventEmitter(),
      exit: () => resolve(),
    });
  });
  child.emit('exit', code);
  await done;
  return { rows, logged };
}

describe('a wrapped server that stops', () => {
  it('is said and kept as a row when it dies with an error', async () => {
    const { rows, logged } = await exited(1);
    expect(rows.map((row) => row.operation)).toEqual(['config.drift.server-down']);
    expect(logged.join('\n')).toContain('railway stopped with exit code 1');
  });

  it('is not news when it ends cleanly', async () => {
    const { rows } = await exited(0);
    expect(rows).toEqual([]);
  });
});
