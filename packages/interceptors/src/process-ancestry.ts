import { execFileSync } from 'node:child_process';

import type { AncestorArgv } from '@memnox/core';

/** Deep enough for agent, shell, subshell and make; a launchd chain never gets near it. */
const MAX_DEPTH = 32;
const PS_TIMEOUT_MS = 2000;

interface ProcessRow {
  ppid: number;
  argv: string[];
}

/**
 * Every ancestor of `pid`, nearest first, from one `ps` so the walk costs one spawn.
 * Empty when ps cannot be read, which leaves only the environment markers to decide.
 */
export function ancestorsOf(
  pid: number,
  listing: () => string = psListing,
): AncestorArgv[] {
  let table: Map<number, ProcessRow>;
  try {
    table = parseListing(listing());
  } catch {
    // No ps (a minimal container) is not a reason to stop somebody's git.
    return [];
  }
  const ancestors: AncestorArgv[] = [];
  let current = table.get(pid);
  for (let depth = 0; current !== undefined && depth < MAX_DEPTH; depth++) {
    ancestors.push(current.argv);
    if (current.ppid <= 1) break;
    current = table.get(current.ppid);
  }
  return ancestors;
}

function psListing(): string {
  return execFileSync('ps', ['-A', '-o', 'pid=,ppid=,args='], {
    encoding: 'utf8',
    timeout: PS_TIMEOUT_MS,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
}

function parseListing(raw: string): Map<number, ProcessRow> {
  const table = new Map<number, ProcessRow>();
  for (const line of raw.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (match === null) continue;
    const [, pid, ppid, args] = match;
    table.set(Number(pid), {
      ppid: Number(ppid),
      argv: (args ?? '').split(/\s+/).filter((arg) => arg.length > 0),
    });
  }
  return table;
}
