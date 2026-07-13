import { parseFirewallArgs } from './firewall-args';
import { McpFirewall } from './firewall';
import {
  ENV_AGENT_TOKEN,
  ENV_FAIL_OPEN,
  ENV_RUNTIME_URL,
  ENV_TOOLS_ALLOW,
  ENV_TOOLS_DENY,
} from './firewall.constants';

const USAGE = `Usage: memnox-mcp-firewall --name <server-name> -- <server command...>

Wraps a stdio MCP server; every tools/call is checked against the Memnox runtime.

Environment:
  ${ENV_RUNTIME_URL}          Memnox runtime base URL
  ${ENV_AGENT_TOKEN}  agent token for the runtime
  ${ENV_TOOLS_ALLOW}  regex — only matching tools are exposed
  ${ENV_TOOLS_DENY}   regex — matching tools are hidden and blocked
  ${ENV_FAIL_OPEN}    "true" to forward calls when the runtime is unreachable

Example:
  MEMNOX_AGENT_TOKEN=mnx_... memnox-mcp-firewall --name github -- npx -y @modelcontextprotocol/server-github`;

function main(): void {
  const args = parseFirewallArgs(process.argv.slice(2));
  if (!args) {
    process.stderr.write(`${USAGE}\n`);
    process.exit(1);
  }

  new McpFirewall({
    command: args.command,
    serverName: args.serverName,
    runtimeUrl: process.env[ENV_RUNTIME_URL],
    agentToken: process.env[ENV_AGENT_TOKEN],
    allowPattern: process.env[ENV_TOOLS_ALLOW],
    denyPattern: process.env[ENV_TOOLS_DENY],
    failOpen: process.env[ENV_FAIL_OPEN] === 'true',
  }).start();
}

main();
