import { join } from 'node:path';
import type { DiscoveredAgent } from '../agent';
import { DISCOVERED_AGENT_KIND, SURFACE_KIND } from '../discovery.constants';
import type { MachineReader } from '../ports';
import type { McpServerLaunch, Surface } from '../surface';
import type {
  AgentDetector,
  DetectionContext,
  DetectionResult,
  HostedAgents,
} from './detector';
import { readMcpServers } from './mcp-config';

/**
 * Ruflo scaffolds beside the work rather than in the home directory, so the marker is
 * whichever of these a checkout has. Every one is from its own user guide: `.ruflo`
 * and `.claude-plugin` were guesses and are gone, and `.harness` was worse than a
 * guess — that directory belongs to Harness.io's CI, and keying on it would have
 * reported Ruflo on every repository that uses a different product entirely.
 *
 * `.claude` alone is not here either: Claude Code writes that on its own.
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

/**
 * Ruflo registers its server into the host's own config rather than a file of its own,
 * so `.mcp.json` is read because that is Claude Code's project convention and a swarm
 * lands there — never because Ruflo is documented to write one.
 */
const PROJECT_MCP_CONFIG = '.mcp.json';
const FEDERATION_MARKERS: readonly string[] = ['.claude-flow/federation'];

/**
 * Ruflo orchestrates agents; it is not one. Its row on the roster is the union of what
 * it launches, because a swarm whose planner reads, whose coder writes and whose
 * deployer holds cloud credentials is one execution capability, not three harmless ones.
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
    if (found.length === 0) return null;

    const agent: DiscoveredAgent = {
      id: `agt_${this.kind}`,
      kind: this.kind,
      configPaths: found,
      clients: ['Ruflo'],
      ownerHint: reader.userName(),
      firstSeen: now,
      lastSeen: now,
    };

    const evidence = found[0] as string;
    /* A harness that installs hooks and spawns workers has a shell and the filesystem
       by construction, whatever any one of its roles is configured with. */
    const surfaces: Surface[] = [
      SURFACE_KIND.SHELL,
      SURFACE_KIND.FILESYSTEM,
      SURFACE_KIND.GIT,
      SURFACE_KIND.NETWORK,
    ].map((kind) => ({ agentId: agent.id, kind, detectedFrom: evidence }));

    const servers = await projectServers(reader, scaffolded);
    if (servers.length > 0 && scaffolded.length > 0) {
      surfaces.push({
        agentId: agent.id,
        kind: SURFACE_KIND.MCP,
        detectedFrom: join(scaffolded[0] as string, PROJECT_MCP_CONFIG),
        tools: [],
        servers,
      });
    }

    return { agent, surfaces, hosted: await hostedIn(reader, scaffolded, found) };
  }
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
      servers.push({ ...server, args: [...server.args], env: [...server.env] });
    }
  }
  return servers;
}

/**
 * The roles, the runtimes and the hooks, each with the path that proved it. A swarm's
 * membership is the only thing that makes its combined reach countable, so it is read
 * off disk rather than taken from a number in somebody's README.
 */
async function hostedIn(
  reader: MachineReader,
  roots: readonly string[],
  evidence: readonly string[],
): Promise<HostedAgents> {
  const roles = new Set<string>();
  const runtimes = new Set<string>();
  const hooks: string[] = [];
  const proof = [...evidence];
  let federated = false;

  for (const root of roots) {
    for (const dir of ROLE_DIRS) {
      const path = join(root, dir);
      // Listed rather than tested for: an unreadable directory and an empty one are
      // the same answer, and neither is evidence of a role.
      const entries = await reader.list(path);
      if (entries.length === 0) continue;
      proof.push(path);
      for (const entry of entries) {
        const name = (entry.split('/')[0] ?? '').replace(/\.(md|json|ya?ml)$/, '');
        if (name !== '') roles.add(name);
      }
    }

    for (const runtime of HOSTED_RUNTIMES) {
      if (await reader.exists(join(root, runtime.path))) runtimes.add(runtime.kind);
    }

    for (const hook of HOOK_PATHS) {
      const path = join(root, hook);
      if (await reader.exists(path)) hooks.push(path);
    }

    for (const marker of FEDERATION_MARKERS) {
      if (await reader.exists(join(root, marker))) federated = true;
    }
  }

  return {
    runtimes: [...runtimes].sort(),
    roles: [...roles].sort(),
    hooks,
    federated,
    evidence: proof,
  };
}
