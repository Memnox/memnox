import { homedir } from 'node:os';
import { parseFirewallArgs } from './firewall-args';
import { McpFirewall } from './firewall';
import { SESSION_VAR } from '@memnox/core';
import {
  ENV_AGENT_NAME,
  ENV_POLICIES,
  ENV_TOOLS_ALLOW,
  ENV_TOOLS_DENY,
} from './firewall.constants';
import { openLedger } from './ledger';
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
  // Opened here rather than inside the proxy: this is the only place that may read a disk.
  const ledger = openLedger(homedir());
  const session = process.env[SESSION_VAR];
  const agent = process.env[ENV_AGENT_NAME];

  new McpFirewall({
    command: args.command,
    serverName: args.serverName,
    ...(gate === null ? {} : { gate }),
    ...(ledger === null ? {} : { ledger }),
    ...(session === undefined ? {} : { sessionId: session }),
    ...(agent === undefined ? {} : { agent }),
    allowPattern: process.env[ENV_TOOLS_ALLOW],
    denyPattern: process.env[ENV_TOOLS_DENY],
  }).start();
}

void main();
