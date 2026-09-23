/**
 * What the Memnox entry says, in whichever format the agent keeps its config. One name,
 * so onboarding twice replaces its own entry and offboarding removes exactly its own.
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
    // The machine credential this agent was enrolled under, which reaches its own workspace only.
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

/** Which format a config file is, by extension, because that is what its agent goes by. */
export function configFormatOf(path: string): ConfigFormat | null {
  const lower = path.toLowerCase();
  if (lower.endsWith('.json')) return CONFIG_FORMAT.JSON;
  if (lower.endsWith('.toml')) return CONFIG_FORMAT.TOML;
  if (lower.endsWith('.yaml') || lower.endsWith('.yml')) return CONFIG_FORMAT.YAML;
  return null;
}
