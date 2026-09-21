/**
 * Where an MCP client keeps its servers, per config format, in one place because a
 * missed spelling reads as a config holding no servers at all.
 */

/** JSON clients. `servers` is VS Code's spelling; everything else uses `mcpServers`. */
export const JSON_SERVER_KEYS = ['mcpServers', 'servers'] as const;

/** TOML clients, chiefly Codex, which accepts either spelling of the table. */
export const TOML_SERVER_TABLES = ['mcp_servers', 'mcpServers'] as const;

/** YAML clients, chiefly Hermes. */
export const YAML_SERVER_KEYS = ['mcp_servers', 'mcpServers'] as const;

/** The spelling a format is written with when this product adds an entry itself. */
export const DEFAULT_SERVER_KEY = {
  json: 'mcpServers',
  toml: 'mcp_servers',
  yaml: 'mcp_servers',
} as const;

/** The key a JSON config keeps its servers under, whichever spelling it chose. */
export function serversKeyOf(config: Record<string, unknown>): string | null {
  for (const key of JSON_SERVER_KEYS) {
    const value = config[key];
    if (typeof value === 'object' && value !== null) return key;
  }
  return null;
}
