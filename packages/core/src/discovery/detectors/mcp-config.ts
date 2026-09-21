import { serversKeyOf } from '../mcp-keys';
import type { McpServerLaunch } from '../surface';

/** Shared by every client that speaks MCP: they all write the same shape. */
export interface McpServerConfig {
  name: string;
  command: string;
  args: string[];
  /** Names only, because a config hands a server credentials and the values stay in the file. */
  env: string[];
}

interface RawServer {
  command?: unknown;
  args?: unknown;
  env?: unknown;
}

/**
 * A config says what a server is called and never what it can do, so this reads only
 * the launch line and the tools are enumerated over the protocol later.
 */
export function readMcpServers(raw: string | null): McpServerConfig[] {
  if (raw === null) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // A half-written client config is a real state; it is absence, not an error.
    return [];
  }
  if (typeof parsed !== 'object' || parsed === null) return [];
  // Narrowed to an object above; its values are still unknown.
  const config = parsed as Record<string, unknown>;
  const key = serversKeyOf(config);
  if (key === null) return [];
  // serversKeyOf only answers with a key whose value is an object.
  return readServerEntries(config[key] as Record<string, unknown>);
}

/** Every entry under a JSON servers key that carries a launch line. */
export function readServerEntries(declared: Record<string, unknown>): McpServerConfig[] {
  const configs: McpServerConfig[] = [];
  for (const [name, value] of Object.entries(declared)) {
    if (typeof value !== 'object' || value === null) continue;
    // Somebody else's JSON: each field is checked before it is used.
    const server = value as RawServer;
    if (typeof server.command !== 'string') continue;
    configs.push({
      name,
      command: server.command,
      args: stringsIn(server.args),
      env: envNamesIn(server.env),
    });
  }
  return configs;
}

/** The strings in a list somebody else wrote, and nothing else from it. */
export function stringsIn(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((each): each is string => typeof each === 'string');
}

/** The keys a config sets for the server. A value read here would be a value stored. */
function envNamesIn(env: unknown): string[] {
  if (typeof env !== 'object' || env === null) return [];
  return Object.keys(env).sort();
}

/**
 * The command an HTTP upstream is recorded under, since it has no launch line of its own.
 * Named so the snapshot can say a server speaks HTTP without matching a bare string.
 */
export const URL_SERVER_COMMAND = 'http';

/** One server as a TOML or YAML config declares it, before it becomes a launch line. */
export interface DeclaredServer {
  name: string;
  command: string | null;
  url: string | null;
  args: string[];
  env: string[];
  disabled: boolean;
}

/** A server declared by launch line or by URL, and null when it declares neither. */
export function resolveServerLaunch(declared: DeclaredServer): McpServerLaunch | null {
  const launch = launchLineOf(declared);
  if (launch === null) return null;
  return {
    name: declared.name,
    ...launch,
    env: declared.env,
    ...(declared.disabled ? { disabled: true } : {}),
  };
}

/** An HTTP upstream has no launch line and is still named, with its URL as the argument. */
function launchLineOf(
  declared: DeclaredServer,
): { command: string; args: string[] } | null {
  if (declared.command !== null)
    return { command: declared.command, args: declared.args };
  return declared.url === null
    ? null
    : { command: URL_SERVER_COMMAND, args: [declared.url] };
}
