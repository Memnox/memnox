import { execFileSync } from 'node:child_process';
import { statSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import {
  CloudLeases,
  holdFor,
  LeaseGate,
  LeaseRegistry,
  SESSION_VAR,
  TtyLeasePrompt,
  type HoldService,
  type LeaseHolder,
} from '@memnox/core';
import { HookAuthorizer } from './hook-authorizer';
import { readHookConfig } from './hook-config';
import { loadHookGate } from './hook-gate-loader';
import { DEFAULT_AGENT_NAME, ENV_AGENT_NAME, ENV_POLICIES } from './tool-hook.constants';

/** stderr is the safe side channel — stdout belongs to whatever protocol is speaking. */
export const log = (message: string): void => {
  process.stderr.write(`[memnox] ${message}\n`);
};

// The environment first, then what was written to config: shared by every local interceptor.
export async function buildAuthorizer(): Promise<HookAuthorizer> {
  const config = await readHookConfig(process.env, homedir());
  const gate = await loadHookGate(config);
  if (gate === null) {
    log(`no gate configured — set ${ENV_POLICIES}`);
  }

  return new HookAuthorizer({
    ...(gate === null ? {} : { gate }),
    log,
  });
}

export async function readStdin(): Promise<string> {
  const chunks: string[] = [];
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) chunks.push(String(chunk));
  return chunks.join('');
}

interface SeamLeases {
  gate: LeaseGate;
  holder: LeaseHolder;
  repositoryRoot: string;
  isDirectory: (path: string) => boolean;
}

/**
 * The register, when there is a repository to have one about.
 *
 * Undefined outside a checkout, and undefined is the right answer rather than a
 * degraded one: a lease is repository-relative, and two machines cannot agree about a
 * path that has no root. A single-agent laptop pays nothing for this either way — the
 * register is only ever consulted for a write, and an empty one never refuses.
 */
export function buildLeases(cwd: string = process.cwd()): SeamLeases | undefined {
  const root = repositoryRoot(cwd);
  if (root === null) return undefined;

  return {
    gate: new LeaseGate({
      registry: new LeaseRegistry(homedir()),
      /* The workspace's register too, so two machines on one repository stop being a
         coin flip. It makes no call at all without an account file, and an
         unreachable control plane never stops a write. */
      shared: new CloudLeases(homedir()),
      prompt: new TtyLeasePrompt(),
      now: () => new Date().toISOString(),
    }),
    holder: {
      agent: process.env[ENV_AGENT_NAME] ?? DEFAULT_AGENT_NAME,
      /* The session `memnox run` set. Without one, every command would be its own
         session and a lease would never survive to the next line. */
      sessionId: process.env[SESSION_VAR] ?? `ses_pid_${process.ppid}`,
      /* The agent, not this wrapper. A wrapper exits the moment its command does, so
         holding its own pid would mark every lease abandoned as soon as it was taken. */
      pid: process.ppid,
    },
    repositoryRoot: root,
    isDirectory: (path: string) => {
      try {
        return statSync(resolve(root, path)).isDirectory();
      } catch {
        // Not there yet: a file about to be written, which claims its directory.
        return false;
      }
    },
  };
}

function repositoryRoot(cwd: string): string | null {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    // Not a repository, which is an answer rather than a failure.
    return null;
  }
}

/**
 * Somebody to ask.
 *
 * Every seam took an optional hold service and nothing ever built one, so an `ask`
 * rule reached "nobody could be asked, so it was denied" — which made `ask` a synonym
 * for `deny` and left no way to run an agent unattended at all.
 *
 * The question is written to `~/.memnox/pending` first and answered from wherever an
 * answer turns up: this terminal when there is one, `memnox approve` in another, or
 * the control plane reading the same directory.
 */
export function buildHold(timeoutMs?: number): HoldService {
  return holdFor({
    home: homedir(),
    /* Opening /dev/tty on a headless box succeeds often enough that asking there
       would swallow the question, so this is asked of stdin instead. */
    interactive: process.stdin.isTTY === true,
    announce: log,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });
}
