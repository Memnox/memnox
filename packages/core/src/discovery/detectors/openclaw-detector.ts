import { join } from 'node:path';
import {
  DISCOVERED_AGENT_KIND,
  SURFACE_KIND,
  type SurfaceKind,
} from '../discovery.constants';
import type { MachineReader } from '../ports';
import { findOutsideQuotes, JSON_QUOTING } from '../scalar-text';
import { FILTER_PRECEDENCE } from '../surface';
import type { McpServerLaunch, ToolFilter } from '../surface';
import { buildDetectedAgent, buildMcpSurfaces, buildSurfaces } from './detected-agent';
import type { AgentDetector, DetectionResult, HostedAgents } from './detector';
import { readServerEntries, stringsIn } from './mcp-config';

/**
 * OpenClaw, whose config is JSON with comments and whose tool filters deny first. Parsed
 * loosely, because a config with one `//` in it must not read as an agent not installed.
 */
const STATE_DIR = '.openclaw';
const CONFIG = '.openclaw/openclaw.json';
/** Where OpenClaw keeps one directory per agent it runs. Each is a principal. */
const AGENTS_DIR = '.openclaw/agents';
const SANDBOX_DIR = '.openclaw/sandboxes';
const CREDENTIALS_DIR = '.openclaw/credentials';
/** Remote nodes, which make it agent-to-agent work across machines. */
const NODES_DIR = '.openclaw/nodes';

/**
 * Surfaces are read from OpenClaw's own allow and deny list rather than assumed, because
 * an agent whose config denies `exec` genuinely has no shell.
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

    const evidence = hasConfig ? configPath : stateDir;
    const agent = buildDetectedAgent({
      kind: this.kind,
      configPaths: [evidence],
      clients: ['OpenClaw'],
      reader,
      now,
    });
    const config = hasConfig ? parseLoose(await reader.read(configPath)) : null;
    const surfaces = [
      ...buildSurfaces(agent.id, grantedSurfaces(config), evidence),
      ...buildMcpSurfaces(agent.id, evidence, openClawServers(config)),
    ];
    return { agent, surfaces, hosted: await hostedIn(reader, config, evidence) };
  }
}

/**
 * The gateway always reaches the network, and the rest is whatever the tool lists leave
 * standing. An unparsed config grants nothing more, because unreadable must never widen.
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

function openClawServers(config: OpenClawConfig | null): McpServerLaunch[] {
  const declared = config?.mcpServers ?? config?.mcp?.servers;
  return declared === undefined ? [] : readServerEntries(declared);
}

/**
 * Every directory under `agents/` is another principal OpenClaw runs, and the roster has
 * to name them: two of them writing one file is a collision only visible if both are known.
 */
async function hostedIn(
  reader: MachineReader,
  config: OpenClawConfig | null,
  evidence: string,
): Promise<HostedAgents> {
  const home = reader.homeDir();
  const roles = new Set(Object.keys(config?.agents?.entries ?? {}));
  const evidencePaths = [evidence];
  const agentsDir = join(home, AGENTS_DIR);
  if (await reader.exists(agentsDir)) {
    for (const entry of await reader.list(agentsDir)) {
      const id = entry.split('/')[0];
      if (id !== undefined && id !== '') roles.add(id);
    }
    evidencePaths.push(agentsDir);
  }
  for (const relative of [SANDBOX_DIR, CREDENTIALS_DIR]) {
    const path = join(home, relative);
    if (await reader.exists(path)) evidencePaths.push(path);
  }

  return {
    runtimes: [],
    roles: [...roles].sort(),
    hooks: [],
    // Remote nodes are the far side a per-machine roster cannot see.
    federated: await reader.exists(join(home, NODES_DIR)),
    evidence: evidencePaths,
  };
}

/**
 * OpenClaw's config is JSON with comments, so what JSON does not allow is stripped first.
 * Anything still unreadable is null, which the caller reads as "grants nothing".
 */
export function parseLoose(raw: string | null): OpenClawConfig | null {
  if (raw === null) return null;
  const withoutComments = stripComments(raw).replace(/,(\s*[}\]])/g, '$1');
  try {
    const parsed: unknown = JSON.parse(withoutComments);
    if (typeof parsed !== 'object' || parsed === null) return null;
    // Every field of OpenClawConfig is optional and checked where it is read.
    return parsed as OpenClawConfig;
  } catch {
    // A config we cannot read is absence. It is never a reason to widen the report.
    return null;
  }
}

/** A comment marker inside a string is data, so only markers outside one are cut. */
function stripComments(raw: string): string {
  let kept = '';
  let rest = raw;
  for (;;) {
    const at = findOutsideQuotes(
      rest,
      (char, index) =>
        char === '/' && (rest[index + 1] === '/' || rest[index + 1] === '*'),
      JSON_QUOTING,
    );
    if (at === -1) return kept + rest;
    kept += rest.slice(0, at);
    const lineComment = rest[at + 1] === '/';
    const end = lineComment ? rest.indexOf('\n', at) : rest.indexOf('*/', at + 2);
    // An unclosed comment runs to the end of the file.
    if (end === -1) return kept;
    rest = rest.slice(lineComment ? end : end + 2);
  }
}
