import { join } from 'node:path';
import { DISCOVERED_AGENT_KIND, SURFACE_KIND } from '../discovery.constants';
import type { MachineReader } from '../ports';
import type { McpServerLaunch } from '../surface';
import { buildDetectedAgent, buildMcpSurfaces, buildSurfaces } from './detected-agent';
import type {
  AgentDetector,
  DetectionContext,
  DetectionResult,
  HostedAgents,
} from './detector';
import { readMcpServers } from './mcp-config';

/**
 * Ruflo scaffolds beside the work, so the marker is whichever of these a checkout has.
 * `.harness` belongs to Harness.io's CI and `.claude` to Claude Code, so neither is here.
 */
const MARKERS: readonly string[] = [
  'claude-flow.config.json',
  '.claude-flow',
  '.swarm',
  '.hive-mind',
];

/** Where it writes the roles it runs. Each directory entry is a separate principal. */
const ROLE_DIRS: readonly string[] = ['.agents', '.claude/agents', '.claude-flow/agents'];

/** Files it installs into somebody else's product, which is where its reach comes from. */
const HOOK_PATHS: readonly string[] = [
  '.claude/settings.json',
  '.claude/helpers/hook-handler.cjs',
  '.githooks',
];

/**
 * The runtimes it drives. Ruflo is a harness: on its own it executes nothing. `.agents`
 * and `AGENTS.md` are what its `--codex` mode writes, so either one names Codex.
 */
const HOSTED_RUNTIMES: readonly { path: string; kind: string }[] = [
  { path: '.claude', kind: DISCOVERED_AGENT_KIND.CLAUDE_CODE },
  { path: '.agents', kind: DISCOVERED_AGENT_KIND.CODEX_CLI },
  { path: 'AGENTS.md', kind: DISCOVERED_AGENT_KIND.CODEX_CLI },
  { path: '.codex', kind: DISCOVERED_AGENT_KIND.CODEX_CLI },
];

/** Ruflo registers its server into the host's project config, which for Claude Code is this. */
const PROJECT_MCP_CONFIG = '.mcp.json';
const FEDERATION_MARKERS: readonly string[] = ['.claude-flow/federation'];

/**
 * Ruflo orchestrates agents rather than being one, so its row is the union of what it
 * launches: a planner that reads and a deployer with credentials are one capability.
 */
export class RufloDetector implements AgentDetector {
  readonly kind = DISCOVERED_AGENT_KIND.RUFLO;
  readonly layoutVersion = '2026-09';

  async detect(
    reader: MachineReader,
    now: string,
    context?: DetectionContext,
  ): Promise<DetectionResult | null> {
    const roots = [reader.homeDir(), ...(context?.projectDirs ?? [])];
    const { found, scaffolded } = await markersIn(reader, roots);
    const [evidence] = found;
    if (evidence === undefined) return null;

    const agent = buildDetectedAgent({
      kind: this.kind,
      configPaths: found,
      clients: ['Ruflo'],
      reader,
      now,
    });
    const servers = await projectServers(reader, scaffolded);
    const firstRoot = scaffolded[0];
    // A harness that installs hooks and spawns workers has a shell by construction.
    const surfaces = [
      ...buildSurfaces(
        agent.id,
        [
          SURFACE_KIND.SHELL,
          SURFACE_KIND.FILESYSTEM,
          SURFACE_KIND.GIT,
          SURFACE_KIND.NETWORK,
        ],
        evidence,
      ),
      ...(firstRoot === undefined
        ? []
        : buildMcpSurfaces(agent.id, join(firstRoot, PROJECT_MCP_CONFIG), servers)),
    ];
    return { agent, surfaces, hosted: await hostedIn(reader, scaffolded, found) };
  }
}

/** Every marker present, and the roots that held one. */
async function markersIn(
  reader: MachineReader,
  roots: readonly string[],
): Promise<{ found: string[]; scaffolded: string[] }> {
  const found: string[] = [];
  const scaffolded: string[] = [];
  for (const root of roots) {
    for (const marker of MARKERS) {
      const path = join(root, marker);
      if (!(await reader.exists(path))) continue;
      found.push(path);
      if (!scaffolded.includes(root)) scaffolded.push(root);
    }
  }
  return { found, scaffolded };
}

async function projectServers(
  reader: MachineReader,
  roots: readonly string[],
): Promise<McpServerLaunch[]> {
  const servers: McpServerLaunch[] = [];
  const seen = new Set<string>();
  for (const root of roots) {
    const raw = await reader.read(join(root, PROJECT_MCP_CONFIG));
    for (const server of readMcpServers(raw)) {
      if (seen.has(server.name)) continue;
      seen.add(server.name);
      servers.push(server);
    }
  }
  return servers;
}

/**
 * The roles, the runtimes and the hooks, each with the path that proved it, read off disk
 * because a swarm's membership is what makes its combined reach countable.
 */
async function hostedIn(
  reader: MachineReader,
  roots: readonly string[],
  evidence: readonly string[],
): Promise<HostedAgents> {
  const hosted: HostedAgents = {
    runtimes: [],
    roles: [],
    hooks: [],
    federated: false,
    evidence: [...evidence],
  };
  for (const root of roots) await readHostedIn(reader, root, hosted);
  return {
    ...hosted,
    runtimes: [...new Set(hosted.runtimes)].sort(),
    roles: [...new Set(hosted.roles)].sort(),
  };
}

/** Adds what one root holds to `hosted`, which is deduplicated once every root is read. */
async function readHostedIn(
  reader: MachineReader,
  root: string,
  hosted: HostedAgents,
): Promise<void> {
  for (const dir of ROLE_DIRS) {
    const path = join(root, dir);
    // Listed rather than tested for: unreadable and empty are the same answer.
    const entries = await reader.list(path);
    if (entries.length === 0) continue;
    hosted.evidence.push(path);
    for (const entry of entries) {
      const name = (entry.split('/')[0] ?? '').replace(/\.(md|json|ya?ml)$/, '');
      if (name !== '') hosted.roles.push(name);
    }
  }
  for (const runtime of HOSTED_RUNTIMES) {
    if (await reader.exists(join(root, runtime.path))) hosted.runtimes.push(runtime.kind);
  }
  for (const hook of HOOK_PATHS) {
    const path = join(root, hook);
    if (await reader.exists(path)) hosted.hooks.push(path);
  }
  for (const marker of FEDERATION_MARKERS) {
    if (await reader.exists(join(root, marker))) hosted.federated = true;
  }
}
