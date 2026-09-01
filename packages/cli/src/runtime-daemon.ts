import { spawn } from 'node:child_process';
import { mkdir, open, readFile, rm, stat, writeFile } from 'node:fs/promises';
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
/** Enough of the child's own output to name the cause, not enough to bury the error. */
const LOG_TAIL_LINES = 12;

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
  /** Whether the spawned process is still running; injected so tests never signal one. */
  alive?: (pid: number) => boolean;
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
  const alive = deps.alive ?? isAlive;

  return async (overrides) => {
    const config = resolveConfig(overrides);
    const paths = daemonPaths(homeDir);
    await mkdir(dirname(paths.logFile), { recursive: true });

    // Where this run's output starts, so a failure quotes its own lines and not the
    // ones from whatever ran yesterday.
    const logFrom = await sizeOf(paths.logFile);

    let pid: number;
    const log = await open(paths.logFile, 'a');
    try {
      const spawned = doSpawn(execPath, [entry, ...serveArgs(overrides)], log.fd);
      if (spawned === undefined)
        throw new Error('could not start the runtime in the background');
      pid = spawned;
      await writeFile(paths.pidFile, String(pid), 'utf8');
    } finally {
      await log.close();
    }

    const url = `http://${config.host}:${config.port}`;
    const deadline = now() + READY_TIMEOUT_MS;
    while (now() < deadline) {
      if (await ready(url)) return { config };
      /* A runtime that refused its own policy file is already gone, and waiting the
         rest of the budget only delays a message it has already written. */
      if (!alive(pid)) throw await startupFailure(paths.logFile, logFrom, 'exited');
      await sleep(READY_POLL_MS);
    }
    throw await startupFailure(
      paths.logFile,
      logFrom,
      `did not answer on ${url} within ${READY_TIMEOUT_MS / 1000}s`,
    );
  };
}

/** Bytes already in the log, so only this run's lines are quoted back. Zero if absent. */
async function sizeOf(filePath: string): Promise<number> {
  try {
    return (await stat(filePath)).size;
  } catch {
    return 0; // No log yet: this is the first run on this machine.
  }
}

/**
 * The reason is in the log the child already wrote — an unreadable policy file, a port
 * in use. Pointing at the file and saying nothing else made the commonest first-run
 * failure look like a timeout, so the last lines come back with the error.
 */
async function startupFailure(
  logFile: string,
  from: number,
  what: string,
): Promise<Error> {
  const tail = await logTail(logFile, from);
  return new Error(
    `the runtime ${what} — see ${logFile}` +
      (tail === '' ? '' : `\n\nwhat it said:\n${tail}`),
  );
}

async function logTail(logFile: string, from: number): Promise<string> {
  let raw: Buffer;
  try {
    raw = await readFile(logFile);
  } catch {
    return ''; // Nothing was written: the error stands on its own.
  }
  /* Sliced as bytes, because `from` is a byte offset from stat and an em dash earlier
     in the file would otherwise shift the cut and behead the first line. */
  const lines = raw
    .subarray(from)
    .toString('utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0);
  return lines
    .slice(-LOG_TAIL_LINES)
    .map((line) => `  ${line}`)
    .join('\n');
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
  return isAlive(pid) ? pid : null;
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

function isAlive(pid: number): boolean {
  try {
    // Signal 0 tests for the process without touching it.
    process.kill(pid, 0);
    return true;
  } catch {
    return false; // Gone — the pid file outlived the process it named.
  }
}
