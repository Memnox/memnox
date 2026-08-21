/** Everything before `--` is ours; everything after is the wrapped server's. */
const COMMAND_SEPARATOR = '--';
const NAME_FLAG = '--name';
const DEFAULT_SERVER_NAME = 'mcp-server';

interface FirewallArgs {
  /** The wrapped MCP server command, e.g. ["npx", "-y", "@some/mcp-server"]. */
  command: string[];
  serverName: string;
}

/** Null means the invocation cannot run and the caller should print usage. */
export function parseFirewallArgs(argv: readonly string[]): FirewallArgs | null {
  const separator = argv.indexOf(COMMAND_SEPARATOR);
  if (separator === -1 || separator === argv.length - 1) return null;

  const flags = argv.slice(0, separator);
  const nameIndex = flags.indexOf(NAME_FLAG);

  return {
    command: argv.slice(separator + 1),
    serverName:
      nameIndex === -1
        ? DEFAULT_SERVER_NAME
        : (flags[nameIndex + 1] ?? DEFAULT_SERVER_NAME),
  };
}
