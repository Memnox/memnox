import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ENFORCEMENT_MODE } from '@memnox/core';
import {
  createDetachedLauncher,
  daemonPaths,
  readDaemonPid,
  serveArgs,
  stopDaemon,
} from '../src/runtime-daemon';
import { registerStopCommand } from '../src/commands/stop.command';
import { runCommand } from './cli-harness';

describe('serveArgs', () => {
  it('rebuilds only the flags setup actually sets', () => {
    expect(
      serveArgs({
        port: 7466,
        host: '127.0.0.1',
        policyFile: 'memnox.policies.yaml',
        behaviorGuard: true,
        trustGuard: false,
        enforcement: { default: ENFORCEMENT_MODE.MONITOR },
      }),
    ).toEqual([
      'serve',
      '--port',
      '7466',
      '--host',
      '127.0.0.1',
      '--policies',
      'memnox.policies.yaml',
      '--behavior-guard',
      '--enforcement',
      'monitor',
    ]);
  });

  it('omits a guard that is off rather than passing a negative flag', () => {
    expect(serveArgs({ behaviorGuard: false, trustGuard: false })).toEqual(['serve']);
  });
});

describe('starting the runtime in the background', () => {
  let homeDir: string;

  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'memnox-daemon-'));
  });

  afterEach(async () => {
    await rm(homeDir, { recursive: true, force: true });
  });

  it('records the pid and returns once the runtime answers', async () => {
    const spawned: { command: string; args: readonly string[] }[] = [];
    let probes = 0;
    const launch = createDetachedLauncher(homeDir, {
      spawn: (command, args) => {
        spawned.push({ command, args });
        return 4821;
      },
      // Not up on the first look — the launcher has to keep waiting.
      ready: async () => ++probes > 1,
      entry: '/cli/index.js',
      execPath: '/usr/bin/node',
      sleep: async () => undefined,
    });

    const server = await launch({ port: 7466, host: '127.0.0.1' });

    expect(server.config.port).toBe(7466);
    expect(spawned).toHaveLength(1);
    expect(spawned[0]?.command).toBe('/usr/bin/node');
    expect(spawned[0]?.args[0]).toBe('/cli/index.js');
    expect(spawned[0]?.args[1]).toBe('serve');
    expect(probes).toBe(2);
    expect(await readFile(daemonPaths(homeDir).pidFile, 'utf8')).toBe('4821');
  });

  it('fails with the log path when the runtime never answers', async () => {
    let clock = 0;
    const launch = createDetachedLauncher(homeDir, {
      spawn: () => 4821,
      ready: async () => false,
      entry: '/cli/index.js',
      execPath: '/usr/bin/node',
      // Spend the whole budget in one step rather than waiting in real time.
      now: () => (clock += 60_000),
      sleep: async () => undefined,
    });

    await expect(launch({ port: 7466, host: '127.0.0.1' })).rejects.toThrow(
      /runtime\.log/,
    );
  });
});

describe('stopping it', () => {
  let homeDir: string;

  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), 'memnox-stop-'));
    await mkdir(join(homeDir, '.memnox'), { recursive: true });
  });

  afterEach(async () => {
    await rm(homeDir, { recursive: true, force: true });
  });

  it('reports nothing to stop when no runtime was started here', async () => {
    expect(await stopDaemon(daemonPaths(homeDir))).toBeNull();

    const { out } = await runCommand(
      (program, context) => registerStopCommand(program, context, homeDir),
      ['stop'],
    );

    expect(out.text).toContain('No background runtime is running');
  });

  it('clears a pid file left behind by a process that is gone', async () => {
    // A reboot leaves the file naming a pid nothing owns any more.
    const paths = daemonPaths(homeDir);
    await writeFile(paths.pidFile, '999999', 'utf8');

    expect(await readDaemonPid(paths)).toBeNull();
    expect(await stopDaemon(paths)).toBeNull();
    await expect(readFile(paths.pidFile, 'utf8')).rejects.toThrow();
  });

  it('signals the recorded pid and forgets it', async () => {
    const paths = daemonPaths(homeDir);
    await writeFile(paths.pidFile, String(process.pid), 'utf8');
    const signalled: number[] = [];

    expect(await stopDaemon(paths, (pid) => signalled.push(pid))).toBe(process.pid);
    expect(signalled).toEqual([process.pid]);
    await expect(readFile(paths.pidFile, 'utf8')).rejects.toThrow();
  });
});
