import { parseFirewallArgs } from './firewall-args';
import { McpFirewall } from './firewall';
import { ENV_POLICIES, ENV_TOOLS_ALLOW, ENV_TOOLS_DENY } from './firewall.constants';
import { loadLocalGate, localGateEnvironment } from './local-gate-loader';

const USAGE = `Usage: memnox-mcp-proxy --name <server-name> -- <server command...>

Wraps a stdio MCP server. Every tools/call is ruled on in this process before it
reaches the server, so a call's arguments never leave the machine.

Normally you do not run this by hand — "memnox mcp wrap" points your agent's config
at it, and "memnox mcp unwrap" puts the config back.

Environment:
  ${ENV_POLICIES}     policy files, comma-separated
  ${ENV_TOOLS_ALLOW}  regex — only matching tools are exposed
  ${ENV_TOOLS_DENY}   regex — matching tools are hidden and denied

Example:
  memnox-mcp-proxy --name github -- npx -y @modelcontextprotocol/server-github`;

async function main(): Promise<void> {
  const args = parseFirewallArgs(process.argv.slice(2));
  if (!args) {
    process.stderr.write(`${USAGE}\n`);
    process.exit(1);
  }

  const gate = await loadLocalGate(localGateEnvironment(process.env), args.serverName);

  new McpFirewall({
    command: args.command,
    serverName: args.serverName,
    ...(gate === null ? {} : { gate }),
    allowPattern: process.env[ENV_TOOLS_ALLOW],
    denyPattern: process.env[ENV_TOOLS_DENY],
  }).start();
}

void main();
