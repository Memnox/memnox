import { homedir } from 'node:os';
import { parseFirewallArgs } from './firewall-args';
import { McpFirewall } from './firewall';
import { CloudActions, CloudNotes, holdFor, SESSION_VAR } from '@memnox/core';
import {
  ENV_AGENT_NAME,
  ENV_POLICIES,
  ENV_TOOLS_ALLOW,
  ENV_TOOLS_DENY,
} from './firewall.constants';
import { openLedger } from './ledger';
import { sessionLimitsFor } from './session-limits';
import { loadLocalGate, localGateEnvironment } from './local-gate-loader';

const USAGE = `Usage: memnox-mcp-proxy --name <server-name> -- <server command...>

Wraps a stdio MCP server. Every tools/call is ruled on in this process before it
reaches the server, so a call's arguments never leave the machine.

Normally you do not run this by hand — "memnox mcp wrap" points your agent's config
at it, and "memnox mcp unwrap" puts the config back.

Environment:
  ${ENV_POLICIES}     policy files, comma-separated. Unset, the rule files this
                      machine has registered are used, so wrapping alone governs.
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

  const home = homedir();
  const gate = await loadLocalGate(
    localGateEnvironment(process.env),
    args.serverName,
    home,
    (message) => process.stderr.write(`memnox: ${message}\n`),
  );
  // Opened here rather than inside the proxy: this is the only place that may read a disk.
  const ledger = openLedger(home);
  const session = process.env[SESSION_VAR];
  /* The environment first, which is what `memnox run` sets, and then the agent
     the wrapped line was written for, which is every server an agent starts on
     its own. */
  const agent = process.env[ENV_AGENT_NAME] ?? args.agent;

  new McpFirewall({
    command: args.command,
    serverName: args.serverName,
    ...(gate === null ? {} : { gate }),
    ...(ledger === null ? {} : { ledger }),
    ...(session === undefined ? {} : { sessionId: session }),
    ...(agent === undefined ? {} : { agent }),
    /* Built here for the same reason the ledger is opened here: this is the only
       place allowed to read a disk, and a proxy that reached for `~/.memnox` on
       its own could not be run in a test without one. */
    limits: sessionLimitsFor({ home }),
    /* Somebody to ask. Without it every `ask` rule an MCP call hits is a refusal
       nobody was offered the chance to answer — and stdin here is the protocol, so
       the question has to be written down and answered from elsewhere. */
    hold: holdFor({
      home,
      /* stdin here is the JSON-RPC stream, so the question can never be asked on it.
         It is written down instead and answered from a terminal or the workspace. */
      interactive: false,
      announce: (message) => process.stderr.write(`memnox: ${message}\n`),
    }),
    /* The workspace's register of what other agents are about to do, so two
       machines do not each send the same message. It makes no call at all
       without an account file, and an unreachable control plane never stops a
       call. */
    actions: new CloudActions(home),
    /* What has been said to this agent, handed over with its next result. The
       same account, and nothing at all is asked without one. */
    notes: new CloudNotes(home),
    allowPattern: process.env[ENV_TOOLS_ALLOW],
    denyPattern: process.env[ENV_TOOLS_DENY],
  }).start();
}

void main();
