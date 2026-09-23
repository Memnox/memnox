/**
 * The session server's entry in each installed agent's MCP config, put in and taken out
 * by the same span edits onboarding uses, so every byte it did not add survives.
 */
import { existsSync } from 'node:fs';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import {
  AGENT_FLAG,
  DEFAULT_SERVER_KEY,
  DISCOVERED_AGENT_KIND,
  SESSION_BINARY,
} from '@memnox/core';

import {
  jsonServerNames,
  jsonServersKey,
  withJsonEntry,
  withoutJsonEntry,
} from '../agents/managed-json';
import {
  CONFIG_FORMAT,
  configFormatOf,
  type RewriteResult,
} from '../agents/managed-shape';
import {
  tomlServerNames,
  withoutManagedTomlServer,
  withTomlStdioServer,
} from '../agents/managed-toml';
import { backupPathFor } from '../memnox-paths';
import { onPath } from '../on-path';

/**
 * Its own name, never the cloud's `memnox`: onboarding rewrites and offboarding deletes
 * exactly that one entry, so two names means neither can ever take the other's place.
 */
export const SESSION_SERVER = 'memnox-session';

/** Kept apart from the proxy's backup of the same file, so neither overwrites the other. */
const SESSION_BACKUP_SUFFIX = '.before-session';

/** One agent that reads MCP servers from a file, by the name the hooks already use. */
export interface SessionTarget {
  /** As a screen prints it, and as `kept.json` records hooked agents. */
  name: string;
  /** The ledger's name for it, passed on the launch line so the server scopes to it. */
  agent: string;
  /** Present only where the agent is installed; a missing one is never invented. */
  installedDir: string;
  file: string;
}

export const SESSION_TARGETS: readonly SessionTarget[] = [
  {
    name: 'Claude Code',
    agent: DISCOVERED_AGENT_KIND.CLAUDE_CODE,
    installedDir: '.claude',
    file: '.claude.json',
  },
  {
    name: 'Codex',
    agent: DISCOVERED_AGENT_KIND.CODEX_CLI,
    installedDir: '.codex',
    file: join('.codex', 'config.toml'),
  },
  {
    name: 'Cursor',
    agent: DISCOVERED_AGENT_KIND.CURSOR,
    installedDir: '.cursor',
    file: join('.cursor', 'mcp.json'),
  },
  {
    name: 'Gemini CLI',
    agent: 'gemini-cli',
    installedDir: '.gemini',
    file: join('.gemini', 'settings.json'),
  },
  {
    name: 'Windsurf',
    agent: 'windsurf',
    installedDir: join('.codeium', 'windsurf'),
    file: join('.codeium', 'windsurf', 'mcp_config.json'),
  },
];

export const PLACED = {
  ABSENT: 'absent',
  PRESENT: 'present',
  WRITTEN: 'written',
  REFUSED: 'refused',
} as const;

type Placed = (typeof PLACED)[keyof typeof PLACED];

/** The launch line an agent gets, naming the agent so the server reads its sessions. */
function sessionLaunch(target: SessionTarget): {
  command: string;
  args: string[];
} {
  return { command: SESSION_BINARY, args: [AGENT_FLAG, target.agent] };
}

async function readOrEmpty(path: string): Promise<string | null> {
  if (!existsSync(path)) return null;
  return readFile(path, 'utf8');
}

/** Every server a config names, or null where it will not parse, which is a refusal. */
function namesIn(raw: string, path: string): string[] | null {
  return configFormatOf(path) === CONFIG_FORMAT.TOML
    ? tomlServerNames(raw)
    : jsonServerNames(raw);
}

function added(raw: string, target: SessionTarget): RewriteResult {
  const launch = sessionLaunch(target);
  if (configFormatOf(target.file) === CONFIG_FORMAT.TOML) {
    return withTomlStdioServer(raw, SESSION_SERVER, launch);
  }
  const key = jsonServersKey(raw) ?? DEFAULT_SERVER_KEY.json;
  return withJsonEntry(raw, key, SESSION_SERVER, launch);
}

function removed(raw: string, path: string): RewriteResult {
  if (configFormatOf(path) === CONFIG_FORMAT.TOML) {
    return withoutManagedTomlServer(raw, SESSION_SERVER);
  }
  const key = jsonServersKey(raw) ?? DEFAULT_SERVER_KEY.json;
  return withoutJsonEntry(raw, key, SESSION_SERVER);
}

/** The rewrite read back: it must parse and still hold every server it held, or it is not written. */
function holdsAll(next: string, path: string, expected: readonly string[]): boolean {
  const after = namesIn(next, path);
  return after !== null && expected.every((name) => after.includes(name));
}

/** Backed up first, because the failure that matters is an agent that will not start. */
async function writeWithBackup(
  home: string,
  path: string,
  before: string | null,
  next: string,
): Promise<void> {
  if (before !== null) {
    const backup = `${backupPathFor(home, path)}${SESSION_BACKUP_SUFFIX}`;
    await mkdir(dirname(backup), { recursive: true, mode: 0o700 });
    await copyFile(path, backup);
  }
  await writeFile(path, next, 'utf8');
}

/** Puts the entry into one agent's config where that agent is installed. */
export async function placeSessionServer(
  home: string,
  target: SessionTarget,
): Promise<Placed> {
  if (!existsSync(join(home, target.installedDir))) return PLACED.ABSENT;
  const path = join(home, target.file);
  const before = await readOrEmpty(path);
  const raw = before ?? (configFormatOf(path) === CONFIG_FORMAT.TOML ? '' : '{}\n');
  const held = namesIn(raw, path);
  if (held === null) return PLACED.REFUSED;
  if (held.includes(SESSION_SERVER)) return PLACED.PRESENT;
  const written = added(raw, target);
  if (written.next === null || !holdsAll(written.next, path, [...held, SESSION_SERVER])) {
    return PLACED.REFUSED;
  }
  await writeWithBackup(home, path, before, written.next);
  return PLACED.WRITTEN;
}

/** Takes the entry back out, touching nothing else; true where there was one to take. */
async function removeSessionServer(
  home: string,
  target: SessionTarget,
): Promise<boolean> {
  const path = join(home, target.file);
  const before = await readOrEmpty(path);
  if (before === null) return false;
  const held = namesIn(before, path);
  if (held === null || !held.includes(SESSION_SERVER)) return false;
  const next = removed(before, path);
  const others = held.filter((name) => name !== SESSION_SERVER);
  if (next.next === null || !holdsAll(next.next, path, others)) return false;
  await writeWithBackup(home, path, before, next.next);
  return true;
}

/** Whether the server can start at all, since an entry for a missing binary only fails loudly. */
function isSessionServerOnPath(resolve: (binary: string) => boolean = onPath): boolean {
  return resolve(SESSION_BINARY);
}

export interface SessionPlacement {
  /** Agents that hold the entry now, whether or not this call wrote it. */
  held: string[];
  /** Agents this call wrote it into. */
  written: string[];
  /** The files this call changed, for the ledger row. */
  files: string[];
}

/** Every installed agent, given the entry where it is missing. */
export async function placeEverywhere(
  home: string,
  targets: readonly SessionTarget[] = SESSION_TARGETS,
): Promise<SessionPlacement> {
  const placement: SessionPlacement = { held: [], written: [], files: [] };
  for (const target of targets) {
    const placed = await placeSessionServer(home, target);
    if (placed === PLACED.PRESENT || placed === PLACED.WRITTEN) {
      placement.held.push(target.name);
    }
    if (placed === PLACED.WRITTEN) {
      placement.written.push(target.name);
      placement.files.push(join(home, target.file));
    }
  }
  return placement;
}

/** Every agent's entry taken out, answering which agents had one. */
export async function removeEverywhere(
  home: string,
  targets: readonly SessionTarget[] = SESSION_TARGETS,
): Promise<string[]> {
  const removedFrom: string[] = [];
  for (const target of targets) {
    if (await removeSessionServer(home, target)) removedFrom.push(target.name);
  }
  return removedFrom;
}

/** What setup and the keeper call: every installed agent, and nothing where the binary is missing. */
export async function wireSessionTools(
  home: string,
  resolve?: (binary: string) => boolean,
): Promise<SessionPlacement> {
  if (!isSessionServerOnPath(resolve)) return { held: [], written: [], files: [] };
  return placeEverywhere(home);
}
