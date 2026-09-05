/**
 * Repointing an agent's MCP servers at the proxy, and putting them back. The backup
 * is written before the rewrite and the restore is byte-identical, because the failure
 * that matters here is leaving somebody's editor unable to start.
 */

export const PROXY_BINARY = 'memnox-mcp-proxy';

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

function isWrapped(launch: ServerLaunch): boolean {
  return launch.command === PROXY_BINARY || launch.args.includes(WRAP_MARKER);
}

/**
 * The wrapped line carries the original verbatim after `--`, so unwrapping is a
 * matter of reading it back rather than reconstructing what it might have been.
 */
export function wrapLaunch(name: string, launch: ServerLaunch): ServerLaunch {
  return {
    command: PROXY_BINARY,
    args: [WRAP_MARKER, '--name', name, '--', launch.command, ...launch.args],
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

export function planWrap(servers: Readonly<Record<string, ServerLaunch>>): WrapPlan {
  const plan: WrapPlan = { wrap: [], alreadyWrapped: [] };
  for (const [name, launch] of Object.entries(servers)) {
    if (isWrapped(launch)) {
      plan.alreadyWrapped.push(name);
      continue;
    }
    plan.wrap.push({ name, before: launch, after: wrapLaunch(name, launch) });
  }
  return plan;
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

/** Where the servers live inside each client's config, since no two agree. */
export const MCP_SERVER_KEYS = ['mcpServers', 'servers'] as const;

export function serversKeyOf(config: Record<string, unknown>): string | null {
  for (const key of MCP_SERVER_KEYS) {
    const value = config[key];
    if (typeof value === 'object' && value !== null) return key;
  }
  return null;
}
