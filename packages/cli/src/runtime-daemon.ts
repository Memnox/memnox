import { spawn } from 'node:child_process';
import { mkdir, open, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { resolveConfig, type RuntimeConfig } from '@memnox/runtime';
import type { ServerLauncher } from './commands/serve.command';

/** One runtime serves every project, so these are machine-local facts, not per-repo. */
const MEMNOX_DIR = '.memnox';
const PID_FILE = 'runtime.pid';
const LOG_FILE = 'runtime.log';

const READY_TIMEOUT_MS = 10_000;
const READY_POLL_MS = 150;
const READY_PATH = '/healthz';

interface DaemonPaths {
  pidFile: string;
  logFile: string;
}

export function daemonPaths(homeDir: string): DaemonPaths {
  return {
    pidFile: join(homeDir, MEMNOX_DIR, PID_FILE),
    logFile: join(homeDir, MEMNOX_DIR, LOG_FILE),
  };
}

/** Spawning, injected so a test never detaches a real process. */
type SpawnDetached = (
  command: string,
  args: readonly string[],
  logFd: number,
) => number | undefined;

const spawnDetached: SpawnDetached = (command, args, logFd) => {
  const child = spawn(command, [...args], {
    detached: true,
    stdio: ['ignore', logFd, logFd],
  });
  // Without this the parent stays alive waiting on a child that outlives it.
  child.unref();
  return child.pid;
};

/** Whether the runtime answers yet. Injected so tests never open a socket. */
type ReadyProbe = (url: string) => Promise<boolean>;

const httpReady: ReadyProbe = async (url) => {
  try {
    const response = await fetch(`${url}${READY_PATH}`, {
      signal: AbortSignal.timeout(READY_POLL_MS * 2),
    });
    return response.ok;
  } catch {
    return false; // Not up yet; the caller keeps waiting until its budget runs out.
  }
};

interface DetachedLauncherDeps {
  spawn?: SpawnDetached;
  ready?: ReadyProbe;
  /** The CLI entry point to re-invoke; argv[1] in a real run. */
  entry?: string;
  /** Node itself, so the child does not depend on a `memnox` on PATH. */
  execPath?: string;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/** Returns once it answers, so `setup` hands the prompt back instead of holding it. */
export function createDetachedLauncher(
  homeDir: string,
  deps: DetachedLauncherDeps = {},
): ServerLauncher {
  const doSpawn = deps.spawn ?? spawnDetached;
  const ready = deps.ready ?? httpReady;
  const entry = deps.entry ?? process.argv[1] ?? '';
  const execPath = deps.execPath ?? process.execPath;
  const now = deps.now ?? Date.now;
  const sleep =
    deps.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));

  return async (overrides) => {
    const config = resolveConfig(overrides);
    const paths = daemonPaths(homeDir);
    await mkdir(dirname(paths.logFile), { recursive: true });

    const log = await open(paths.logFile, 'a');
    try {
      const pid = doSpawn(execPath, [entry, ...serveArgs(overrides)], log.fd);
      if (pid === undefined)
        throw new Error('could not start the runtime in the background');
      await writeFile(paths.pidFile, String(pid), 'utf8');
    } finally {
      await log.close();
    }

    const url = `http://${config.host}:${config.port}`;
    const deadline = now() + READY_TIMEOUT_MS;
    while (now() < deadline) {
      if (await ready(url)) return { config };
      await sleep(READY_POLL_MS);
    }
    throw new Error(
      `the runtime did not answer on ${url} within ${READY_TIMEOUT_MS / 1000}s — see ${paths.logFile}`,
    );
  };
}

/** Rebuilds the flags for the fields `setup` sets; order is stable for tests. */
export function serveArgs(overrides: Partial<RuntimeConfig>): string[] {
  const args = ['serve'];
  if (overrides.port !== undefined) args.push('--port', String(overrides.port));
  if (overrides.host !== undefined) args.push('--host', overrides.host);
  if (overrides.policyFile !== undefined) args.push('--policies', overrides.policyFile);
  if (overrides.policyRegistryFile !== undefined) {
    args.push('--policy-registry', overrides.policyRegistryFile);
  }
  if (overrides.behaviorGuard === true) args.push('--behavior-guard');
  if (overrides.trustGuard === true) args.push('--trust-guard');
  if (overrides.verificationGuard === true) args.push('--verification-guard');
  // Absent means enforce, which is `serve`'s own default.
  const mode = overrides.enforcement?.default;
  if (mode !== undefined) args.push('--enforcement', mode);
  return args;
}

/** The pid recorded for the background runtime, or null when none is running. */
export async function readDaemonPid(paths: DaemonPaths): Promise<number | null> {
  let raw: string;
  try {
    raw = await readFile(paths.pidFile, 'utf8');
  } catch {
    return null; // No pid file: nothing was started from here yet.
  }
  const pid = Number.parseInt(raw.trim(), 10);
  if (!Number.isInteger(pid) || pid <= 0) return null;
  return alive(pid) ? pid : null;
}

/** Signals the background runtime to stop. Returns the pid it stopped, or null. */
export async function stopDaemon(
  paths: DaemonPaths,
  kill: (pid: number) => void = (pid) => process.kill(pid, 'SIGTERM'),
): Promise<number | null> {
  const pid = await readDaemonPid(paths);
  if (pid === null) {
    // A stale file is the normal case after a reboot; clear it either way.
    await rm(paths.pidFile, { force: true });
    return null;
  }
  kill(pid);
  await rm(paths.pidFile, { force: true });
  return pid;
}

function alive(pid: number): boolean {
  try {
    // Signal 0 tests for the process without touching it.
    process.kill(pid, 0);
    return true;
  } catch {
    return false; // Gone — the pid file outlived the process it named.
  }
}
