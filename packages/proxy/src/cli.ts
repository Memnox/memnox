import { homedir } from 'node:os';

import {
  FileToolPins,
  loadOrCreateConfig,
  CloudActions,
  CloudNotes,
  ENV_AGENT_NAME,
  ENV_POLICIES,
  EXIT,
  holdFor,
  openLedger,
  openNotice,
  PROBATION_KIND,
  ProbationRegister,
  probationOf,
  protectionStopped,
  SESSION_VAR,
  trustCommandFor,
  UNNAMED_AGENT,
  type ContainedProbation,
  type HoldService,
  type LocalGate,
  type UnusualNotice,
} from '@memnox/core';

import { parseFirewallArgs } from './firewall-args';
import { McpFirewall, type FirewallOptions } from './firewall';
import { ENV_TOOLS_ALLOW, ENV_TOOLS_DENY } from './firewall.constants';
import { loadLocalGate, localGateEnvironment } from './local-gate-loader';
import { sessionLimitsFor } from './session-limits';

/**
 * The proxy as a process, which is what an agent's config actually launches. Everything
 * that reads a disk is built here, so the proxy itself runs in a test with none.
 */

const USAGE = `Usage: memnox-mcp-proxy --name <server-name> -- <server command...>

Wraps a stdio MCP server. Every tools/call is ruled on in this process before it
reaches the server, so a call's arguments never leave the machine.

Normally you do not run this by hand: "memnox mcp wrap" points your agent's config
at it, and "memnox mcp unwrap" puts the config back.

Environment:
  ${ENV_POLICIES}     policy files, comma-separated. Unset, the rule files this
                      machine has registered are used, so wrapping alone governs.
  ${ENV_TOOLS_ALLOW}  regex, and only matching tools are exposed
  ${ENV_TOOLS_DENY}   regex, and matching tools are hidden and denied

Example:
  memnox-mcp-proxy --name github -- npx -y @modelcontextprotocol/server-github`;

function warn(message: string): void {
  process.stderr.write(`memnox: ${message}\n`);
}

async function main(): Promise<void> {
  const args = parseFirewallArgs(process.argv.slice(2));
  if (!args) {
    process.stderr.write(`${USAGE}\n`);
    process.exit(EXIT.FAILED);
  }

  new McpFirewall(await firewallOptionsFor(args, homedir())).start();
}

/** Everything the proxy is wired to on this machine, read once where it starts. */
async function firewallOptionsFor(
  args: NonNullable<ReturnType<typeof parseFirewallArgs>>,
  home: string,
): Promise<FirewallOptions> {
  const gate = await loadLocalGate(
    localGateEnvironment(process.env),
    args.serverName,
    home,
    warn,
  );
  const ledger = openLedger(home);
  const session = process.env[SESSION_VAR];
  // The environment `memnox run` sets, then the agent the wrapped line was written for.
  const agent = process.env[ENV_AGENT_NAME] ?? args.agent;
  const mode = (await loadOrCreateConfig(home).catch(() => null))?.mode;

  return {
    command: args.command,
    serverName: args.serverName,
    ...(gate === null ? {} : { gate }),
    ...(ledger === null ? {} : { ledger }),
    ...(session === undefined ? {} : { sessionId: session }),
    ...(agent === undefined ? {} : { agent }),
    limits: sessionLimitsFor({ home }),
    stopped: () => protectionStopped(home),
    hold: buildHold(home),
    // The workspace's register and inbox; neither makes a call without an account file.
    actions: new CloudActions(home),
    notes: new CloudNotes(home),
    probation: () => serverProbation(home, args.serverName),
    notice: await noticeFor({ home, gate, agent, session }),
    // What each server listed last time, so a tool that arrived since is said at once.
    pins: new FileToolPins(home),
    ...(mode === undefined ? {} : { mode }),
    allowPattern: process.env[ENV_TOOLS_ALLOW],
    denyPattern: process.env[ENV_TOOLS_DENY],
  };
}

interface NoticeWiring {
  home: string;
  gate: LocalGate | null;
  agent: string | undefined;
  session: string | undefined;
}

/**
 * On the rules here, and handed to the firewall, so a flagged result
 * taints the session that every other seam of this agent reads.
 */
async function noticeFor(wiring: NoticeWiring): Promise<UnusualNotice> {
  const { home, gate, agent, session } = wiring;
  const notice = await openNotice(home, {
    agent: agent ?? UNNAMED_AGENT,
    ...(session === undefined ? {} : { sessionId: session }),
  });
  gate?.attachNotice(notice);
  return notice;
}

/** This server's probation, read at each call so `memnox mcp trust` applies at once. */
async function serverProbation(
  home: string,
  server: string,
): Promise<ContainedProbation | null> {
  const entries = await new ProbationRegister(home).all();
  const entry = probationOf(entries, PROBATION_KIND.MCP_SERVER, server, new Date());
  if (entry === null) return null;
  return {
    name: entry.label ?? entry.name,
    until: entry.until,
    trustCommand: trustCommandFor(entry.kind, entry.name),
  };
}

/**
 * stdin here is the JSON-RPC stream, so a question
 * is written down and answered from elsewhere.
 */
function buildHold(home: string): HoldService {
  return holdFor({ home, interactive: false, announce: warn });
}

void main();
