/**
 * What the Memnox entry says, in whichever format the agent keeps its config.
 *
 * One name, `memnox`, so onboarding twice replaces its own entry rather than
 * leaving two, and so offboarding removes exactly what onboarding added and
 * nothing a person put there.
 */

export const MANAGED_SERVER = 'memnox';

/** What the entry claims, so a person reading their own config knows why it is there. */
export interface ManagedServer {
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

export interface RewriteResult {
  /** The config as it should now be written, or null where it cannot be. */
  next: string | null;
  /** Why, where it cannot. Said to the person rather than swallowed. */
  because?: string;
}

export const CONFIG_FORMAT = {
  JSON: 'json',
  TOML: 'toml',
  YAML: 'yaml',
} as const;

export type ConfigFormat = (typeof CONFIG_FORMAT)[keyof typeof CONFIG_FORMAT];

/**
 * Which format a config file is, from its name.
 *
 * By extension rather than by sniffing the contents, because the extension is
 * what the agent that owns the file goes by: a `.toml` holding something that
 * happens to parse as YAML is still a file Codex will read as TOML.
 */
export function formatOf(path: string): ConfigFormat | null {
  const lower = path.toLowerCase();
  if (lower.endsWith('.json')) return CONFIG_FORMAT.JSON;
  if (lower.endsWith('.toml')) return CONFIG_FORMAT.TOML;
  if (lower.endsWith('.yaml') || lower.endsWith('.yml')) return CONFIG_FORMAT.YAML;
  return null;
}
