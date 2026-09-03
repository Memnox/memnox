/** Shared by every client that speaks MCP: they all write the same shape. */
export interface McpServerConfig {
  name: string;
  command: string;
  args: string[];
  /**
   * Names only, never values. What a config hands a server is the answer to "what
   * credentials does this thing get", and the value itself never leaves the file.
   */
  env: string[];
}

interface RawServer {
  command?: unknown;
  args?: unknown;
  env?: unknown;
}

/**
 * A config says what a server is called; it never says what the server can do. This
 * reads only the launch line, and the tools are enumerated over the protocol later.
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
  const servers = (parsed as Record<string, unknown>)['mcpServers'];
  if (typeof servers !== 'object' || servers === null) return [];

  const configs: McpServerConfig[] = [];
  for (const [name, value] of Object.entries(servers as Record<string, unknown>)) {
    if (typeof value !== 'object' || value === null) continue;
    const server = value as RawServer;
    if (typeof server.command !== 'string') continue;
    const args = Array.isArray(server.args)
      ? server.args.filter((arg): arg is string => typeof arg === 'string')
      : [];
    configs.push({ name, command: server.command, args, env: envNamesIn(server.env) });
  }
  return configs;
}

/** The keys a config sets for the server. A value read here would be a value stored. */
function envNamesIn(env: unknown): string[] {
  if (typeof env !== 'object' || env === null) return [];
  return Object.keys(env as Record<string, unknown>).sort();
}
