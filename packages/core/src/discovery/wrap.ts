import { DISCOVERED_AGENT_KIND, type DiscoveredAgentKind } from './discovery.constants';

/**
 * Repointing an agent's MCP servers at the proxy, and putting them back byte for byte,
 * because the failure that matters here is leaving somebody's editor unable to start.
 */

export const PROXY_BINARY = 'memnox-mcp-proxy';

/** Memnox's own session server: it answers from the ledger, so a proxy in front of it would govern itself. */
export const SESSION_BINARY = 'memnox-session';

/** Which agent launched the proxy, written into the line so the proxy can say. */
export const AGENT_FLAG = '--agent';

/** Marks a launch line this tool wrote, so unwrap never has to guess. */
export const WRAP_MARKER = '--memnox-wrapped';

export interface ServerLaunch {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

export interface WrapPlan {
  /** Servers that would be repointed, with the line they would get. */
  wrap: { name: string; before: ServerLaunch; after: ServerLaunch }[];
  /** Servers already routed through the proxy. Re-wrapping one would nest it. */
  alreadyWrapped: string[];
}

/** A launch line as any caller holds it, whether read from a config or a scan. */
type LaunchLine = Pick<ServerLaunch, 'command'> & { args: readonly string[] };

/**
 * Whether this entry is a command a proxy could stand in front of. `ServerLaunch` is a
 * cast over somebody else's JSON, and a server declared by URL has no `command`.
 */
function isLaunch(launch: LaunchLine): boolean {
  if (typeof launch !== 'object' || launch === null) return false;
  return typeof launch.command === 'string' && Array.isArray(launch.args);
}

/** Whether this line starts Memnox's own session server, which is never wrapped. */
export function isOwnServer(launch: LaunchLine): boolean {
  if (!isLaunch(launch)) return false;
  return launch.command.split(/[\\/]/).pop() === SESSION_BINARY;
}

/** Whether this line already routes through the proxy, so it is never wrapped twice. */
export function isWrapped(launch: LaunchLine): boolean {
  if (!isLaunch(launch)) return false;
  return launch.command === PROXY_BINARY || launch.args.includes(WRAP_MARKER);
}

/**
 * The wrapped line carries the original verbatim after `--`, so unwrapping is a
 * matter of reading it back rather than reconstructing what it might have been.
 */
export function wrapLaunch(
  name: string,
  launch: ServerLaunch,
  agent?: DiscoveredAgentKind,
): ServerLaunch {
  // The agent's environment says nothing about who it is, so the line has to name it.
  const naming = agent === undefined ? [] : [AGENT_FLAG, agent];
  return {
    command: PROXY_BINARY,
    args: [WRAP_MARKER, '--name', name, ...naming, '--', launch.command, ...launch.args],
    ...(launch.env === undefined ? {} : { env: launch.env }),
  };
}

/** Null when the line was not one we wrote, so nothing else is ever touched. */
export function unwrapLaunch(launch: ServerLaunch): ServerLaunch | null {
  if (!isWrapped(launch)) return null;
  const at = launch.args.indexOf('--');
  if (at === -1) return null;
  const original = launch.args.slice(at + 1);
  const command = original[0];
  if (command === undefined) return null;
  return {
    command,
    args: original.slice(1),
    ...(launch.env === undefined ? {} : { env: launch.env }),
  };
}

export function planWrap(
  servers: Readonly<Record<string, ServerLaunch>>,
  agent?: DiscoveredAgentKind,
): WrapPlan {
  const plan: WrapPlan = { wrap: [], alreadyWrapped: [] };
  for (const [name, launch] of Object.entries(servers)) {
    // A URL server has no command to stand in front of, so it is left exactly as it is.
    if (!isLaunch(launch)) continue;
    // Our own server, left as it is: wrapping it would put Memnox in front of itself.
    if (isOwnServer(launch)) continue;
    if (isWrapped(launch)) {
      plan.alreadyWrapped.push(name);
      continue;
    }
    plan.wrap.push({ name, before: launch, after: wrapLaunch(name, launch, agent) });
  }
  return plan;
}

/**
 * Lines this tool wrapped without the agent in them, rewritten with it so a refusal can
 * name the agent. Only lines this tool wrote, and only where the config has one agent.
 */
export function planUpgrade(
  servers: Readonly<Record<string, ServerLaunch>>,
  agent: DiscoveredAgentKind | undefined,
): { name: string; after: ServerLaunch }[] {
  if (agent === undefined) return [];
  const upgrades: { name: string; after: ServerLaunch }[] = [];
  for (const [name, launch] of Object.entries(servers)) {
    if (!isWrapped(launch) || launch.args.includes(AGENT_FLAG)) continue;
    const original = unwrapLaunch(launch);
    if (original === null) continue;
    upgrades.push({ name, after: wrapLaunch(name, original, agent) });
  }
  return upgrades;
}

export function planUnwrap(servers: Readonly<Record<string, ServerLaunch>>): {
  restore: { name: string; after: ServerLaunch }[];
  untouched: string[];
} {
  const restore: { name: string; after: ServerLaunch }[] = [];
  const untouched: string[] = [];
  for (const [name, launch] of Object.entries(servers)) {
    const original = unwrapLaunch(launch);
    if (original === null) {
      untouched.push(name);
      continue;
    }
    restore.push({ name, after: original });
  }
  return { restore, untouched };
}

/** Every place an MCP server can be declared, read by the detectors, `mcp wrap` and the wiring check alike. */
export interface McpConfigLocation {
  /** Relative to the home directory, or to the directory the reader is standing in. */
  relative: string;
  scope: 'home' | 'project';
  /** The product that writes it, for a line that names what is not covered. */
  product: string;
  /** The agent whose servers these are. Absent for `.mcp.json`, which several agents read. */
  agent?: DiscoveredAgentKind;
}

export const MCP_CONFIG_LOCATIONS: readonly McpConfigLocation[] = [
  {
    relative: '.claude.json',
    scope: 'home',
    product: 'Claude Code',
    agent: DISCOVERED_AGENT_KIND.CLAUDE_CODE,
  },
  {
    relative: 'Library/Application Support/Claude/claude_desktop_config.json',
    scope: 'home',
    product: 'Claude Desktop',
    agent: DISCOVERED_AGENT_KIND.CLAUDE_DESKTOP,
  },
  {
    relative: '.config/Claude/claude_desktop_config.json',
    scope: 'home',
    product: 'Claude Desktop',
    agent: DISCOVERED_AGENT_KIND.CLAUDE_DESKTOP,
  },
  {
    relative: '.cursor/mcp.json',
    scope: 'home',
    product: 'Cursor',
    agent: DISCOVERED_AGENT_KIND.CURSOR,
  },
  {
    relative: '.cline/settings.json',
    scope: 'home',
    product: 'Cline',
    agent: DISCOVERED_AGENT_KIND.CLINE,
  },
  {
    relative: '.vscode/mcp.json',
    scope: 'home',
    product: 'VS Code',
    agent: DISCOVERED_AGENT_KIND.VS_CODE,
  },
  {
    relative: '.openclaw/openclaw.json',
    scope: 'home',
    product: 'OpenClaw',
    agent: DISCOVERED_AGENT_KIND.OPENCLAW,
  },
  {
    relative: '.codex/config.toml',
    scope: 'home',
    product: 'Codex CLI',
    agent: DISCOVERED_AGENT_KIND.CODEX_CLI,
  },
  {
    relative: '.hermes/config.yaml',
    scope: 'home',
    product: 'Hermes',
    agent: DISCOVERED_AGENT_KIND.HERMES,
  },
  {
    relative: '.hermes/config.yml',
    scope: 'home',
    product: 'Hermes',
    agent: DISCOVERED_AGENT_KIND.HERMES,
  },
  { relative: '.mcp.json', scope: 'project', product: 'Ruflo' },
];
