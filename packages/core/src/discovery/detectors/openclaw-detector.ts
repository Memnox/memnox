import { join } from 'node:path';
import type { DiscoveredAgent } from '../agent';
import {
  DISCOVERED_AGENT_KIND,
  SURFACE_KIND,
  type SurfaceKind,
} from '../discovery.constants';
import type { MachineReader } from '../ports';
import { FILTER_PRECEDENCE } from '../surface';
import type { McpServerLaunch, Surface, ToolFilter } from '../surface';
import type { AgentDetector, DetectionResult, HostedAgents } from './detector';

const STATE_DIR = '.openclaw';
const CONFIG = '.openclaw/openclaw.json';
/** Where OpenClaw keeps one directory per agent it runs. Each is a principal. */
const AGENTS_DIR = '.openclaw/agents';
const SANDBOX_DIR = '.openclaw/sandboxes';
const CREDENTIALS_DIR = '.openclaw/credentials';

/**
 * OpenClaw names its own tools, so the surfaces here are read from its allow/deny list
 * rather than assumed. An agent whose config denies `exec` genuinely has no shell, and
 * reporting one anyway would be the same overstatement this tool exists to correct.
 */
const TOOL_SURFACES: Record<string, SurfaceKind> = {
  exec: SURFACE_KIND.SHELL,
  process: SURFACE_KIND.SHELL,
  read: SURFACE_KIND.FILESYSTEM,
  write: SURFACE_KIND.FILESYSTEM,
  edit: SURFACE_KIND.FILESYSTEM,
  apply_patch: SURFACE_KIND.FILESYSTEM,
  browser: SURFACE_KIND.BROWSER,
};

interface OpenClawConfig {
  tools?: { allow?: unknown; deny?: unknown; sandbox?: unknown };
  agents?: { entries?: Record<string, unknown> };
  mcpServers?: Record<string, unknown>;
  mcp?: { servers?: Record<string, unknown> };
}

export class OpenClawDetector implements AgentDetector {
  readonly kind = DISCOVERED_AGENT_KIND.OPENCLAW;
  readonly layoutVersion = '2026-09';

  async detect(reader: MachineReader, now: string): Promise<DetectionResult | null> {
    const home = reader.homeDir();
    const configPath = join(home, CONFIG);
    const stateDir = join(home, STATE_DIR);
    const hasConfig = await reader.exists(configPath);
    if (!hasConfig && !(await reader.exists(stateDir))) return null;

    const found = hasConfig ? [configPath] : [stateDir];
    const agent: DiscoveredAgent = {
      id: `agt_${this.kind}`,
      kind: this.kind,
      configPaths: found,
      clients: ['OpenClaw'],
      ownerHint: reader.userName(),
      firstSeen: now,
      lastSeen: now,
    };

    const evidence = found[0] as string;
    const config = hasConfig ? parseLoose(await reader.read(configPath)) : null;
    const surfaces: Surface[] = grantedSurfaces(config).map((kind) => ({
      agentId: agent.id,
      kind,
      detectedFrom: evidence,
    }));

    const servers = openClawServers(config);
    if (servers.length > 0) {
      surfaces.push({
        agentId: agent.id,
        kind: SURFACE_KIND.MCP,
        detectedFrom: evidence,
        tools: [],
        servers,
      });
    }

    return { agent, surfaces, hosted: await hostedIn(reader, home, config, evidence) };
  }
}

/**
 * The gateway always reaches the network, and the rest is whatever the tool lists
 * leave standing. A config that could not be parsed grants nothing beyond that: an
 * unreadable file must never widen what we claim an agent can do.
 */
function grantedSurfaces(config: OpenClawConfig | null): SurfaceKind[] {
  const kinds = new Set<SurfaceKind>([SURFACE_KIND.NETWORK]);
  if (config === null) return [...kinds];

  const filter = toolFilter(config.tools);
  for (const [tool, kind] of Object.entries(TOOL_SURFACES)) {
    if (denied(tool, filter)) continue;
    kinds.add(kind);
  }
  return [...kinds];
}

function denied(tool: string, filter: ToolFilter | undefined): boolean {
  if (filter === undefined) return false;
  if (filter.exclude.includes(tool)) return true;
  const allow = filter.include ?? [];
  return allow.length > 0 && !allow.includes(tool);
}

function toolFilter(tools: OpenClawConfig['tools']): ToolFilter | undefined {
  if (tools === undefined) return undefined;
  const include = stringsIn(tools.allow);
  const exclude = stringsIn(tools.deny);
  if (include.length === 0 && exclude.length === 0) return undefined;
  // OpenClaw resolves the pair the other way round: deny is checked first.
  return { include, exclude, precedence: FILTER_PRECEDENCE.EXCLUDE_WINS };
}

function stringsIn(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((each): each is string => typeof each === 'string');
}

function openClawServers(config: OpenClawConfig | null): McpServerLaunch[] {
  if (config === null) return [];
  const declared = config.mcpServers ?? config.mcp?.servers;
  if (declared === undefined) return [];

  const servers: McpServerLaunch[] = [];
  for (const [name, value] of Object.entries(declared)) {
    if (typeof value !== 'object' || value === null) continue;
    const entry = value as { command?: unknown; args?: unknown; env?: unknown };
    if (typeof entry.command !== 'string') continue;
    servers.push({
      name,
      command: entry.command,
      args: stringsIn(entry.args),
      // Names only: what a config hands a server is a key here, never a value.
      env:
        typeof entry.env === 'object' && entry.env !== null
          ? Object.keys(entry.env as Record<string, unknown>).sort()
          : [],
    });
  }
  return servers;
}

/**
 * Every directory under `agents/` is another principal OpenClaw runs, and the roster
 * has to name them: two of them writing the same file is a collision Memnox can only
 * see if it knew there were two.
 */
async function hostedIn(
  reader: MachineReader,
  home: string,
  config: OpenClawConfig | null,
  evidence: string,
): Promise<HostedAgents> {
  const roles = new Set(Object.keys(config?.agents?.entries ?? {}));
  const agentsDir = join(home, AGENTS_DIR);
  const onDisk: string[] = [];
  if (await reader.exists(agentsDir)) {
    for (const entry of await reader.list(agentsDir)) {
      const id = entry.split('/')[0];
      if (id !== undefined && id !== '') roles.add(id);
    }
    onDisk.push(agentsDir);
  }

  const evidencePaths = [evidence, ...onDisk];
  for (const relative of [SANDBOX_DIR, CREDENTIALS_DIR]) {
    const path = join(home, relative);
    if (await reader.exists(path)) evidencePaths.push(path);
  }

  return {
    runtimes: [],
    roles: [...roles].sort(),
    hooks: [],
    /* OpenClaw's remote nodes are agent-to-agent work across machines, which is the
       thing a per-machine roster cannot see the far side of. */
    federated: await reader.exists(join(home, '.openclaw/nodes')),
    evidence: evidencePaths,
  };
}

/**
 * OpenClaw's config is JSON with comments, so a plain parse rejects a valid file. This
 * strips what JSON does not allow and parses the rest; anything still unreadable comes
 * back null, and the caller treats null as "grants nothing" rather than as an error.
 */
export function parseLoose(raw: string | null): OpenClawConfig | null {
  if (raw === null) return null;
  const withoutComments = stripComments(raw).replace(/,(\s*[}\]])/g, '$1');
  try {
    const parsed: unknown = JSON.parse(withoutComments);
    if (typeof parsed !== 'object' || parsed === null) return null;
    return parsed as OpenClawConfig;
  } catch {
    // A config we cannot read is absence. It is never a reason to widen the report.
    return null;
  }
}

/** A comment marker inside a string is data, so quote state is tracked. */
function stripComments(raw: string): string {
  let out = '';
  let quoted = false;
  let escaped = false;
  for (let at = 0; at < raw.length; at += 1) {
    const char = raw[at] as string;
    if (quoted) {
      out += char;
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') {
      quoted = true;
      out += char;
      continue;
    }
    if (char === '/' && raw[at + 1] === '/') {
      const end = raw.indexOf('\n', at);
      if (end === -1) break;
      at = end - 1;
      continue;
    }
    if (char === '/' && raw[at + 1] === '*') {
      const end = raw.indexOf('*/', at + 2);
      if (end === -1) break;
      at = end + 1;
      continue;
    }
    out += char;
  }
  return out;
}
