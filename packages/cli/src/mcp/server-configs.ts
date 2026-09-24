/** Reading this machine's MCP configs and rewriting their launch lines, backup first. */
import { dirname, join } from 'node:path';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import {
  CONFIG_FORMAT,
  formatOf,
  MCP_CONFIG_LOCATIONS,
  PROXY_BINARY,
  readTextServers,
  rewriteTextServers,
  serversKeyOf,
  type ConfigFormat,
  type DiscoveredAgentKind,
  type ServerLaunch,
} from '@memnox/core';
import { backupPathFor } from '../memnox-paths';
import { onPath } from '../on-path';

export interface ConfigFile {
  path: string;
  raw: string;
  format: ConfigFormat;
  /** Only a JSON config carries these; a text one is edited in place instead. */
  config?: Record<string, unknown>;
  key?: string;
  servers: Record<string, ServerLaunch>;
  /** Servers declared by URL. Named so a run can say what it skipped and why. */
  urlOnly: string[];
  /** The agent these servers belong to, written into each wrapped line. */
  agent?: DiscoveredAgentKind;
}

/** One server's new launch line. */
interface Relaunch {
  name: string;
  after: ServerLaunch;
}

/** Answers whether a binary can be found, injected so a test needs no PATH. */
export type BinaryResolver = (binary: string) => boolean;

const JSON_INDENT = 2;

/**
 * Whether the proxy can be started, checked before a config is touched, because an agent
 * pointed at a missing binary starts nothing at all, which is worse than ungoverned.
 */
export function isProxyOnPath(resolveBinary: BinaryResolver = onPath): boolean {
  return resolveBinary(PROXY_BINARY);
}

/** Every MCP config this machine has, from the one list the detectors also read. */
export async function readConfigs(home: string, project: string): Promise<ConfigFile[]> {
  const found: ConfigFile[] = [];
  for (const each of MCP_CONFIG_LOCATIONS) {
    const path = join(each.scope === 'home' ? home : project, each.relative);
    const owner = each.agent === undefined ? {} : { agent: each.agent };
    const file = await readConfig(path);
    if (file !== null) found.push({ ...file, ...owner });
  }
  return found;
}

/** One config with servers in it, or null for a file that is absent, unparsed or empty. */
async function readConfig(path: string): Promise<ConfigFile | null> {
  const raw = await readIfPresent(path);
  if (raw === null) return null;
  const format = formatOf(path);
  if (format !== CONFIG_FORMAT.JSON) {
    const { servers, urlOnly } = readTextServers(format, raw);
    if (Object.keys(servers).length === 0 && urlOnly.length === 0) return null;
    return { path, raw, format, servers, urlOnly };
  }
  let config: Record<string, unknown>;
  try {
    // Cast is checked by serversKeyOf below, which finds no servers in anything else.
    config = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    // Never rewrite a file we could not parse: we would lose what it held.
    return null;
  }
  const key = serversKeyOf(config);
  if (key === null) return null;
  // Cast is safe: serversKeyOf only names a key holding the servers table.
  const servers = config[key] as Record<string, ServerLaunch>;
  return { path, raw, format, config, key, servers, urlOnly: [] };
}

async function readIfPresent(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch (err) {
    // A config this machine does not have is the ordinary case, not a failure.
    // Cast is safe: a failed readFile rejects with an ErrnoException.
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

/**
 * Writes the new launch lines, backing the file up first because the failure that matters
 * is an editor that will not start. JSON is written whole; TOML and YAML keep every other byte.
 */
export async function writeRelaunches(
  home: string,
  file: ConfigFile,
  relaunches: readonly Relaunch[],
): Promise<void> {
  const changed: Record<string, ServerLaunch> = {};
  for (const each of relaunches) changed[each.name] = each.after;

  const backup = backupPathFor(home, file.path);
  await mkdir(dirname(backup), { recursive: true, mode: 0o700 });
  await copyFile(file.path, backup);

  if (file.format !== CONFIG_FORMAT.JSON || file.key === undefined) {
    await writeFile(
      file.path,
      rewriteTextServers(file.format, file.raw, changed),
      'utf8',
    );
    return;
  }
  const next = { ...file.config, [file.key]: { ...file.servers, ...changed } };
  await writeFile(file.path, `${JSON.stringify(next, null, JSON_INDENT)}\n`, 'utf8');
}
