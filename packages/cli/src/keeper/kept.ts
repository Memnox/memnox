import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { MEMNOX_HOME } from '@memnox/core';

/**
 * What `setup` put on this machine and asked the daemon to keep there. Absent until setup
 * runs and gone after `uninstall`, so a machine nobody set up is never rewired by a daemon.
 */

export const KEPT_FILE = 'kept.json';

export interface Kept {
  /** When setup first asked for the boundary to be kept. */
  since: string;
  /** Agents whose edit hook was in place at least once, so a missing one was taken out. */
  hooked: string[];
  /** Agents somebody took the hook out of on purpose, which the keeper leaves alone. */
  declined: string[];
  /** False once somebody ran `memnox mcp unwrap`, so new servers are left unwrapped. */
  mcp: boolean;
  /** False once somebody took the session tools out on purpose; absent means kept. */
  session?: boolean;
}

function keptPath(home: string): string {
  return join(home, MEMNOX_HOME, KEPT_FILE);
}

/** Null where setup never ran, or where the file is not ours to read. */
export async function readKept(home: string): Promise<Kept | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(keptPath(home), 'utf8'));
    return isKept(parsed) ? parsed : null;
  } catch {
    // No file is the ordinary state of a machine setup has not reached.
    return null;
  }
}

export async function writeKept(home: string, kept: Kept): Promise<void> {
  await mkdir(join(home, MEMNOX_HOME), { recursive: true });
  await writeFile(keptPath(home), `${JSON.stringify(kept, null, 2)}\n`, 'utf8');
}

/** Called by setup: keeps what was declined before, and adds what is hooked now. */
export async function keepBoundary(
  home: string,
  hooked: readonly string[],
  now: Date = new Date(),
): Promise<void> {
  const before = await readKept(home);
  await writeKept(home, {
    since: before === null ? now.toISOString() : before.since,
    hooked: union(before === null ? [] : before.hooked, hooked),
    declined: (before === null ? [] : before.declined).filter(
      (agent) => !hooked.includes(agent),
    ),
    mcp: true,
  });
}

/** One agent's hook taken out on purpose, or put back on purpose. Quiet before setup. */
export async function markHook(
  home: string,
  agent: string,
  wanted: boolean,
): Promise<void> {
  const kept = await readKept(home);
  if (kept === null) return;
  const declined = kept.declined.filter((each) => each !== agent);
  await writeKept(home, { ...kept, declined: wanted ? declined : [...declined, agent] });
}

/** MCP wrapping turned off on purpose, or back on. Quiet before setup. */
export async function markMcp(home: string, wanted: boolean): Promise<void> {
  const kept = await readKept(home);
  if (kept === null) return;
  await writeKept(home, { ...kept, mcp: wanted });
}

/** The session tools taken out of every agent on purpose, or put back. Quiet before setup. */
export async function markSession(home: string, wanted: boolean): Promise<void> {
  const kept = await readKept(home);
  if (kept === null) return;
  await writeKept(home, { ...kept, session: wanted });
}

export async function forgetKept(home: string): Promise<void> {
  await rm(keptPath(home), { force: true });
}

function union(left: readonly string[], right: readonly string[]): string[] {
  return [...new Set([...left, ...right])];
}

function isKept(value: unknown): value is Kept {
  if (value === null || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record['since'] === 'string' &&
    isNames(record['hooked']) &&
    isNames(record['declined']) &&
    typeof record['mcp'] === 'boolean'
  );
}

function isNames(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((each) => typeof each === 'string');
}
