/**
 * The Memnox server entry an onboarded agent gets, and taking it back out.
 *
 * One name, `memnox`, so onboarding twice replaces its own entry rather than
 * leaving two, and so offboarding removes exactly what onboarding added and
 * nothing a person put there.
 *
 * JSON only, deliberately. Claude Code, Claude Desktop, Cursor, Cline, VS Code
 * and OpenClaw all keep their servers in JSON; Codex is TOML and Hermes is
 * YAML, and rewriting those means a serializer that has to round-trip somebody
 * else's comments and ordering. `memnox mcp wrap` already declines to rewrite
 * what it cannot parse, for the same reason: never rewrite a file we could not
 * read back, because we would lose what it held.
 */

export const MANAGED_SERVER = 'memnox';

/** What the entry claims, so a person reading their own config knows why it is there. */
interface ManagedServer {
  type: 'http';
  url: string;
  headers: Record<string, string>;
}

export function managedServerFor(mcpUrl: string, token: string): ManagedServer {
  return {
    type: 'http',
    url: mcpUrl,
    /* The machine credential this agent was enrolled under. It reaches its own
       workspace and nothing else, and it is the same credential the control
       plane checks on every other machine route. */
    headers: { Authorization: `Bearer ${token}` },
  };
}

interface RewriteResult {
  /** The config as it should now be written, or null where it cannot be. */
  next: string | null;
  /** Why, where it cannot. Said to the person rather than swallowed. */
  because?: string;
}

/**
 * Adds the managed server, keeping everything else exactly as it was.
 *
 * Reads and rewrites the same object rather than composing a new one, so keys
 * this knows nothing about survive: an agent's model settings, its permissions,
 * its own MCP servers. Losing those would be a far worse outcome than not
 * onboarding at all.
 */
export function withManagedServer(
  raw: string,
  serversKey: string,
  server: ManagedServer,
): RewriteResult {
  let config: Record<string, unknown>;
  try {
    config = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return { next: null, because: 'its config is not JSON this can rewrite' };
  }
  const held = config[serversKey];
  const servers =
    held !== null && typeof held === 'object' ? (held as Record<string, unknown>) : {};

  const next = {
    ...config,
    [serversKey]: { ...servers, [MANAGED_SERVER]: server },
  };
  return { next: `${JSON.stringify(next, null, 2)}\n` };
}

/**
 * Takes the managed server back out.
 *
 * Used only where the backup cannot be restored. Restoring is the honest undo
 * because it puts back exactly what was there, including anything a person
 * changed by hand afterwards being *lost* rather than merged, which is what an
 * undo means. This is the fallback for a backup that has gone missing.
 */
export function withoutManagedServer(raw: string, serversKey: string): RewriteResult {
  let config: Record<string, unknown>;
  try {
    config = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return { next: null, because: 'its config is not JSON this can rewrite' };
  }
  const held = config[serversKey];
  if (held === null || typeof held !== 'object') return { next: raw };

  const servers = { ...(held as Record<string, unknown>) };
  if (!(MANAGED_SERVER in servers)) return { next: raw };
  delete servers[MANAGED_SERVER];

  return {
    next: `${JSON.stringify({ ...config, [serversKey]: servers }, null, 2)}\n`,
  };
}
