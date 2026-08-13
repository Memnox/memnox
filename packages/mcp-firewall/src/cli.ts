import { parseFirewallArgs } from './firewall-args';
import { McpFirewall } from './firewall';
import {
  ENV_AGENT_TOKEN,
  ENV_FAIL_OPEN,
  ENV_POLICIES,
  ENV_RUNTIME_URL,
  ENV_TOOLS_ALLOW,
  ENV_TOOLS_DENY,
} from './firewall.constants';
import { loadLocalGate, localGateEnvironment } from './local-gate-loader';

const USAGE = `Usage: memnox-mcp-firewall --name <server-name> -- <server command...>

Wraps a stdio MCP server; every tools/call is checked against the Memnox runtime.

Environment:
  ${ENV_RUNTIME_URL}          Memnox runtime base URL
  ${ENV_AGENT_TOKEN}  agent token for the runtime
  ${ENV_TOOLS_ALLOW}  regex — only matching tools are exposed
  ${ENV_TOOLS_DENY}   regex — matching tools are hidden and blocked
  ${ENV_FAIL_OPEN}    "true" to forward calls when the runtime is unreachable
  ${ENV_POLICIES}       policy files evaluated in-process, comma-separated —
                        the only place a call's arguments are ever read

Example:
  MEMNOX_AGENT_TOKEN=mnx_... memnox-mcp-firewall --name github -- npx -y @modelcontextprotocol/server-github`;

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
    runtimeUrl: process.env[ENV_RUNTIME_URL],
    agentToken: process.env[ENV_AGENT_TOKEN],
    allowPattern: process.env[ENV_TOOLS_ALLOW],
    denyPattern: process.env[ENV_TOOLS_DENY],
    failOpen: process.env[ENV_FAIL_OPEN] === 'true',
  }).start();
}

void main();
