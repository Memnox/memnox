import { execFileSync } from 'node:child_process';
import { statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, resolve } from 'node:path';
import {
  ownProcessEnv,
  CloudLeases,
  GitRegionReader,
  holderPid,
  holdFor,
  LeaseGate,
  LeaseRegistry,
  protectionStopped,
  rememberRepository,
  SHARED_LEASE_TIMEOUT_MS,
  ENV_AGENT_NAME,
  ENV_POLICIES,
  SESSION_VAR,
  TtyLeasePrompt,
  type HoldService,
  type LeaseHolder,
  type WrittenRegion,
} from '@memnox/core';
import { HookAuthorizer } from './hook-authorizer';
import { readHookConfig } from './hook-config';
import { loadHookGate } from './hook-gate-loader';
import { DEFAULT_AGENT_NAME } from './tool-hook.constants';

/**
 * What every seam process builds the same way:
 * its log, its authorizer, its leases, its hold.
 */

/**
 * stderr is the safe side channel, because stdout
 * belongs to whatever protocol is speaking.
 */
export function log(message: string): void {
  process.stderr.write(`[memnox] ${message}\n`);
}

// The environment first, then what was written
// to config: shared by every local interceptor.
export async function buildAuthorizer(): Promise<HookAuthorizer> {
  const config = await readHookConfig(process.env, homedir());
  const gate = await loadHookGate(config);
  if (gate === null) log(`no gate configured, so set ${ENV_POLICIES}`);
  return new HookAuthorizer({
    ...(gate === null ? {} : { gate }),
    stopped: () => protectionStopped(homedir()),
  });
}

export async function readStdin(): Promise<string> {
  const chunks: string[] = [];
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) chunks.push(String(chunk));
  return chunks.join('');
}

/**
 * The session a seam files its work under when `memnox
 * run` named none: the agent process above it.
 */
export function pidSessionId(pid: number): string {
  return `ses_pid_${pid}`;
}

export interface SeamLeases {
  gate: LeaseGate;
  holder: LeaseHolder;
  repositoryRoot: string;
  isDirectory: (path: string) => boolean;
}

/**
 * How a seam with nobody at a terminal takes a lease: an editor's hook, which shares its
 * host's terminal and is killed by its host if it waits as long as a person may.
 */
export interface UnattendedLeases {
  /** The editor's session, which is what makes a second write a renewal. */
  sessionId: string;
  /** The longest a held path is waited on. */
  waitMs: number;
  /** The agent the hook was installed for, when the environment does not name one. */
  agent?: string;
  /** What the write is about to touch, since a hook runs before the change lands. */
  region?: (path: string) => Promise<WrittenRegion>;
}

/**
 * The register, when there is a repository to have one about. Undefined outside a
 * checkout, because a lease is repository relative, and an empty register never refuses.
 */
export function buildLeases(
  cwd: string = process.cwd(),
  unattended?: UnattendedLeases,
): SeamLeases | undefined {
  const root = repositoryRootOf(cwd);
  if (root === null) return undefined;
  // The daemon watches the repositories seams have
  // seen, so an agent with no hooks is seen too.
  rememberRepository(homedir(), root);

  return {
    gate: new LeaseGate({
      registry: new LeaseRegistry(homedir()),
      // The workspace's register too; it makes no call
      // without an account and never stops a write.
      shared: new CloudLeases(
        homedir(),
        globalThis.fetch,
        SHARED_LEASE_TIMEOUT_MS,
        basename(root),
      ),
      ...(unattended === undefined
        ? { prompt: new TtyLeasePrompt() }
        : { ceilingMs: unattended.waitMs }),
      // The lines and function a write touches, read off the change itself and bounded.
      region: unattended?.region ?? ((path) => new GitRegionReader(root).read(path)),
      now: () => new Date().toISOString(),
    }),
    holder: holderFor(unattended),
    repositoryRoot: root,
    isDirectory: (path: string) => isDirectoryIn(root, path),
  };
}

/**
 * The agent, never this wrapper, and never init, which no lease could be reclaimed from.
 */
function holderFor(unattended: UnattendedLeases | undefined): LeaseHolder {
  // A hook runs through a shell that exits the moment
  // it answers, so its owner is the editor above.
  const parent = unattended === undefined ? process.ppid : pastShell(process.ppid);
  const owner = holderPid(parent, process.pid);
  return {
    agent: process.env[ENV_AGENT_NAME] ?? unattended?.agent ?? DEFAULT_AGENT_NAME,
    // Without a session every command would be its own,
    // and no lease would survive to the next line.
    sessionId:
      process.env[SESSION_VAR] ??
      (unattended === undefined ? pidSessionId(owner) : unattended.sessionId),
    pid: owner,
  };
}

function isDirectoryIn(root: string, path: string): boolean {
  try {
    return statSync(resolve(root, path)).isDirectory();
  } catch {
    // Not there yet: a file about to be written, which claims its directory.
    return false;
  }
}
/** Shells a host may run a hook command through. */
const SHELLS: readonly string[] = ['sh', 'bash', 'zsh', 'dash'];

/**
 * The process above a shell, asked of `ps` because
 * Node names no grandparent. Falls back to `pid`.
 */
function pastShell(pid: number): number {
  try {
    const line = execFileSync('ps', ['-o', 'ppid=,comm=', '-p', String(pid)], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const match = /^(\d+)\s+(.+)$/.exec(line);
    if (match === null) return pid;
    const name = basename((match[2] ?? '').replace(/^-/, ''));
    return SHELLS.includes(name) ? Number(match[1]) : pid;
  } catch {
    // No `ps`, or the shell already gone: the parent is the best answer there is.
    return pid;
  }
}

/** The checkout `cwd` is in, or null outside one. */
export function repositoryRootOf(cwd: string): string | null {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd,
      // The real git: the one on PATH is this interceptor, which would ask this again.
      env: ownProcessEnv(),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    // Not a repository, which is an answer rather than a failure.
    return null;
  }
}

/**
 * Somebody to ask, so an `ask` rule is not a synonym for
 * `deny`. The question is written to `~/.memnox/pending` first
 * and answered from this terminal, another, or the workspace.
 */
export function buildHold(timeoutMs?: number): HoldService {
  return holdFor({
    home: homedir(),
    // /dev/tty opens on a headless box often enough
    // to swallow the question, so stdin decides.
    interactive: process.stdin.isTTY === true,
    announce: log,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });
}
