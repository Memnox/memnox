import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';

import { relayEndingSignals, signalledExit } from '../src/child-signals';

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe('relayEndingSignals', () => {
  it('stops the real command when its wrapper is sent SIGTERM, and reports 143', async () => {
    const wrapper = new EventEmitter();
    const child = spawn('sleep', ['30'], { stdio: 'ignore' });
    const detach = relayEndingSignals(child, wrapper);
    const ended = new Promise<number>((resolve) => {
      child.on('exit', (code, signal) => {
        detach();
        resolve(code ?? signalledExit(signal, 1));
      });
    });

    wrapper.emit('SIGTERM');

    await expect(ended).resolves.toBe(143);
    expect(child.pid === undefined ? false : alive(child.pid)).toBe(false);
    expect(wrapper.listenerCount('SIGTERM')).toBe(0);
    expect(wrapper.listenerCount('SIGHUP')).toBe(0);
  });

  it('relays SIGHUP as well, which a closed terminal sends', async () => {
    const wrapper = new EventEmitter();
    const child = spawn('sleep', ['30'], { stdio: 'ignore' });
    relayEndingSignals(child, wrapper);
    const ended = new Promise<NodeJS.Signals | null>((resolve) => {
      child.on('exit', (_code, signal) => resolve(signal));
    });

    wrapper.emit('SIGHUP');

    await expect(ended).resolves.toBe('SIGHUP');
  });
});

describe('signalledExit', () => {
  it('numbers a known signal the way a shell does and falls back otherwise', () => {
    expect(signalledExit('SIGTERM', 1)).toBe(143);
    expect(signalledExit('SIGHUP', 1)).toBe(129);
    expect(signalledExit('SIGQUIT', 1)).toBe(1);
    expect(signalledExit(null, 2)).toBe(2);
  });
});
