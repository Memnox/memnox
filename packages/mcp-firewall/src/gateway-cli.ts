import {
  DEFAULT_GATEWAY_HOST,
  DEFAULT_GATEWAY_PATH,
  DEFAULT_GATEWAY_PORT,
  ENV_GATEWAY_HOST,
  ENV_GATEWAY_PORT,
  ENV_UPSTREAM_AUTHORIZATION,
  ENV_UPSTREAM_URL,
} from './gateway.constants';
import {
  ENV_FAIL_OPEN,
  ENV_ON_SECRET,
  ENV_POLICIES,
  ENV_RUNTIME_URL,
  ENV_TOOLS_ALLOW,
  ENV_TOOLS_DENY,
} from './firewall.constants';
import { loadLocalGate, localGateEnvironment } from './local-gate-loader';
import { parseGatewayArgs } from './gateway-args';
import { McpGateway } from './mcp-gateway';
import { HttpUpstreamServer } from './upstream-server';

const USAGE = `Usage: memnox-mcp-gateway --name <server-name>

Fronts a remote MCP server over HTTP; every tools/call is checked against the
Memnox runtime before it reaches the server. Each caller presents its own agent
token, so the audit trail names the agent that made the call.

Environment:
  ${ENV_UPSTREAM_URL}            the MCP server to front (required)
  ${ENV_RUNTIME_URL}                Memnox runtime base URL (required)
  ${ENV_UPSTREAM_AUTHORIZATION}  credential for the upstream server, if it needs one
  ${ENV_GATEWAY_HOST}   bind host (default ${DEFAULT_GATEWAY_HOST})
  ${ENV_GATEWAY_PORT}   bind port (default ${DEFAULT_GATEWAY_PORT})
  ${ENV_TOOLS_ALLOW}        regex — only matching tools are exposed
  ${ENV_TOOLS_DENY}         regex — matching tools are hidden and blocked
  ${ENV_FAIL_OPEN}      "true" to forward calls when the runtime is unreachable
  ${ENV_POLICIES}         policy files evaluated in-process, comma-separated —
                          the only place a call's arguments are ever read
  ${ENV_ON_SECRET}        a secret in an argument: block (default) | redact | signal

Callers POST JSON-RPC to ${DEFAULT_GATEWAY_PATH} with:
  Authorization: Bearer <the calling agent's mnx_ token>

Example:
  MEMNOX_MCP_UPSTREAM=https://mcp.internal/github \\
  MEMNOX_URL=https://memnox.internal \\
  memnox-mcp-gateway --name github`;

async function main(): Promise<void> {
  const config = parseGatewayArgs(process.argv.slice(2), process.env);
  if (config === null) {
    process.stderr.write(`${USAGE}\n`);
    process.exit(1);
  }

  const gate = await loadLocalGate(localGateEnvironment(process.env), config.serverName);

  await new McpGateway({
    upstream: new HttpUpstreamServer({
      url: config.upstreamUrl,
      ...(config.authorization === undefined
        ? {}
        : { authorization: config.authorization }),
    }),
    serverName: config.serverName,
    runtimeUrl: config.runtimeUrl,
    host: config.host,
    port: config.port,
    path: DEFAULT_GATEWAY_PATH,
    allowPattern: config.allowPattern,
    denyPattern: config.denyPattern,
    failOpen: config.failOpen,
    ...(gate === null ? {} : { gate }),
  }).listen();
}

void main();
