import { join } from 'node:path';
import type { DiscoveredAgent } from '../agent';
import { DISCOVERED_AGENT_KIND, SURFACE_KIND } from '../discovery.constants';
import type { MachineReader } from '../ports';
import { FILTER_PRECEDENCE } from '../surface';
import type { McpServerLaunch, Surface, ToolFilter } from '../surface';
import type { AgentDetector, DetectionResult, HostedAgents } from './detector';
import { blockAt, listIn, parseYamlBlocks, type YamlBlock } from './yaml-block';

/** Hermes keeps everything in one YAML file, so the whole detector is one read. */
const CONFIG = '.hermes/config.yaml';
const ALTERNATE = '.hermes/config.yml';

/**
 * Hermes already filters tools per server, so this reads the filter rather than
 * ignoring it: what it reports is what a Hermes agent can actually call, and the
 * tools Hermes itself took away are counted instead of quietly disappearing.
 */
export class HermesDetector implements AgentDetector {
  readonly kind = DISCOVERED_AGENT_KIND.HERMES;
  readonly layoutVersion = '2026-09';

  async detect(reader: MachineReader, now: string): Promise<DetectionResult | null> {
    const home = reader.homeDir();
    let path: string | null = null;
    for (const relative of [CONFIG, ALTERNATE]) {
      const candidate = join(home, relative);
      if (await reader.exists(candidate)) {
        path = candidate;
        break;
      }
    }
    if (path === null) return null;

    const root = parseYamlBlocks(await reader.read(path));
    const agent: DiscoveredAgent = {
      id: `agt_${this.kind}`,
      kind: this.kind,
      configPaths: [path],
      clients: ['Hermes'],
      ownerHint: reader.userName(),
      firstSeen: now,
      lastSeen: now,
    };

    // Hermes runs tools in-process off a shell, so these hold whatever the config says.
    const surfaces: Surface[] = [
      SURFACE_KIND.SHELL,
      SURFACE_KIND.FILESYSTEM,
      SURFACE_KIND.NETWORK,
    ].map((kind) => ({ agentId: agent.id, kind, detectedFrom: path }));

    const servers = hermesServers(root);
    if (servers.length > 0) {
      surfaces.push({
        agentId: agent.id,
        kind: SURFACE_KIND.MCP,
        detectedFrom: path,
        tools: [],
        servers,
      });
    }

    return { agent, surfaces, hosted: hostedIn(root, path) };
  }
}

/** Names, launch lines and filters. Never a header value and never an env value. */
function hermesServers(root: YamlBlock): McpServerLaunch[] {
  const block = blockAt(root, 'mcp_servers');
  if (block === null) return [];

  const servers: McpServerLaunch[] = [];
  for (const [name, entry] of block.children) {
    const command = entry.children.get('command')?.value;
    const url = entry.children.get('url')?.value;
    // An HTTP upstream has no launch line; it is still a server and is still named.
    if (command === undefined && url === undefined) continue;

    const filter = filterIn(entry);
    servers.push({
      name,
      command: command ?? 'http',
      args:
        command === undefined
          ? [url as string]
          : listIn(entry.children.get('args') ?? null),
      env: [...(entry.children.get('env')?.children.keys() ?? [])].sort(),
      ...(filter === undefined ? {} : { filter }),
      ...(entry.children.get('enabled')?.value === 'false' ? { disabled: true } : {}),
    });
  }
  return servers;
}

/**
 * Present and empty are different answers here. Hermes registers nothing for an
 * explicit `include: []` — the "uncheck everything" path in its own installer — so an
 * absent key and an empty one cannot be collapsed into the same value.
 */
function filterIn(entry: YamlBlock): ToolFilter | undefined {
  const tools = entry.children.get('tools');
  if (tools === undefined) return undefined;
  const declared = tools.children.get('include');
  const include = declared === undefined ? undefined : listIn(declared);
  const exclude = listIn(tools.children.get('exclude') ?? null);
  if (include === undefined && exclude.length === 0) return undefined;
  return {
    ...(include === undefined ? {} : { include }),
    exclude,
    precedence: FILTER_PRECEDENCE.INCLUDE_WINS,
  };
}

/**
 * Hermes is a harness: the roles in its config are separate principals at the seam,
 * and counting it as one agent understates it by however many it launches.
 */
function hostedIn(root: YamlBlock, path: string): HostedAgents {
  const roles = [...(blockAt(root, 'agents')?.children.keys() ?? [])];
  return {
    /* Empty on purpose: Hermes executes its own roles rather than driving another
       product, and printing the model here would call a model a runtime. */
    runtimes: [],
    roles,
    hooks: [],
    federated: false,
    evidence: [path],
  };
}
