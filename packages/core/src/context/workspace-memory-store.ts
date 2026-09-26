/**
 * The workspace memory this machine last pulled, kept beside the rules so a hook reads it
 * with no network near it. Owner only, since it holds what the organization settled.
 */
import { mkdir, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { MEMNOX_HOME } from '../config/config';
import { writeAtomic } from '../store/atomic-file';
import { readJsonFile, writeJsonFile } from '../store/json-records';
import { WORKSPACE_MEMORY_FILE, WORKSPACE_MEMORY_SYNCED_FILE } from './context.constants';
import { parseWorkspaceMemory, type WorkspaceMemory } from './workspace-memory';

const OWNER_ONLY_DIR = 0o700;

export function workspaceMemoryPathFor(home: string): string {
  return join(home, MEMNOX_HOME, WORKSPACE_MEMORY_FILE);
}

function syncedPathFor(home: string): string {
  return join(home, MEMNOX_HOME, WORKSPACE_MEMORY_SYNCED_FILE);
}

/**
 * Null when this machine has never pulled one, which is every machine not connected. The
 * sync time is read from its own small file where one is newer than the memory's.
 */
export async function readWorkspaceMemory(home: string): Promise<WorkspaceMemory | null> {
  const raw = await readJsonFile<Record<string, unknown>>(workspaceMemoryPathFor(home));
  if (raw === null || typeof raw['syncedAt'] !== 'string') return null;
  const synced = await readJsonFile<{ at?: unknown }>(syncedPathFor(home));
  const at =
    synced !== null && typeof synced.at === 'string' && synced.at > raw['syncedAt']
      ? synced.at
      : raw['syncedAt'];
  return parseWorkspaceMemory(raw, at);
}

/** Compact rather than pretty, since nobody reads it by hand and it can run to megabytes. */
export async function writeWorkspaceMemory(
  home: string,
  memory: WorkspaceMemory,
): Promise<void> {
  const path = workspaceMemoryPathFor(home);
  await mkdir(dirname(path), { recursive: true, mode: OWNER_ONLY_DIR });
  await writeAtomic(path, JSON.stringify(memory));
  await markWorkspaceMemorySynced(home, memory.syncedAt);
}

/** An unchanged memory moves only this, so a 304 writes a few bytes rather than the set. */
export async function markWorkspaceMemorySynced(home: string, at: string): Promise<void> {
  await writeJsonFile(syncedPathFor(home), { at });
}

interface Cached {
  mtimeMs: number;
  size: number;
  memory: WorkspaceMemory | null;
}

const cached = new Map<string, Cached>();

/**
 * The same, parsed again only when the file changed, for a process that lives long enough
 * to ask twice: the session server. A hook is a new process each call and gains nothing.
 */
export async function readWorkspaceMemoryCached(
  home: string,
): Promise<WorkspaceMemory | null> {
  let found;
  try {
    found = await stat(workspaceMemoryPathFor(home));
  } catch {
    cached.delete(home);
    return null;
  }
  const held = cached.get(home);
  if (held !== undefined && held.mtimeMs === found.mtimeMs && held.size === found.size) {
    return withSyncTime(home, held.memory);
  }
  const memory = await readWorkspaceMemory(home);
  cached.set(home, { mtimeMs: found.mtimeMs, size: found.size, memory });
  return memory;
}

/** The set as parsed, with the sync time read fresh, since a 304 moves only that. */
async function withSyncTime(
  home: string,
  memory: WorkspaceMemory | null,
): Promise<WorkspaceMemory | null> {
  if (memory === null) return null;
  const synced = await readJsonFile<{ at?: unknown }>(syncedPathFor(home));
  if (synced === null || typeof synced.at !== 'string' || synced.at <= memory.syncedAt) {
    return memory;
  }
  return { ...memory, syncedAt: synced.at };
}
