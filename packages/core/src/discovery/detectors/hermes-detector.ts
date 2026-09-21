import { join } from 'node:path';
import { DISCOVERED_AGENT_KIND, SURFACE_KIND } from '../discovery.constants';
import { DEFAULT_SERVER_KEY } from '../mcp-keys';
import type { MachineReader } from '../ports';
import { FILTER_PRECEDENCE } from '../surface';
import type { McpServerLaunch, ToolFilter } from '../surface';
import { buildDetectedAgent, buildMcpSurfaces, buildSurfaces } from './detected-agent';
import type { AgentDetector, DetectionResult, HostedAgents } from './detector';
import { resolveServerLaunch } from './mcp-config';
import { blockAt, listIn, parseYamlBlocks, type YamlBlock } from './yaml-block';

/** Hermes keeps everything in one YAML file, so the whole detector is one read. */
const CONFIG_PATHS: readonly string[] = ['.hermes/config.yaml', '.hermes/config.yml'];

/**
 * Hermes filters tools per server, so the filter is read rather than ignored: what is
 * reported is what a Hermes agent can call, and what Hermes took away is counted.
 */
export class HermesDetector implements AgentDetector {
  readonly kind = DISCOVERED_AGENT_KIND.HERMES;
  readonly layoutVersion = '2026-09';

  async detect(reader: MachineReader, now: string): Promise<DetectionResult | null> {
    const path = await firstExisting(reader, CONFIG_PATHS);
    if (path === null) return null;

    const root = parseYamlBlocks(await reader.read(path));
    const agent = buildDetectedAgent({
      kind: this.kind,
      configPaths: [path],
      clients: ['Hermes'],
      reader,
      now,
    });
    // Hermes runs tools in-process off a shell, so these hold whatever the config says.
    const surfaces = [
      ...buildSurfaces(
        agent.id,
        [SURFACE_KIND.SHELL, SURFACE_KIND.FILESYSTEM, SURFACE_KIND.NETWORK],
        path,
      ),
      ...buildMcpSurfaces(agent.id, path, hermesServers(root)),
    ];
    return { agent, surfaces, hosted: hostedIn(root, path) };
  }
}

async function firstExisting(
  reader: MachineReader,
  relatives: readonly string[],
): Promise<string | null> {
  for (const relative of relatives) {
    const candidate = join(reader.homeDir(), relative);
    if (await reader.exists(candidate)) return candidate;
  }
  return null;
}

/** Names, launch lines and filters. Never a header value and never an env value. */
function hermesServers(root: YamlBlock): McpServerLaunch[] {
  const block = blockAt(root, DEFAULT_SERVER_KEY.yaml);
  if (block === null) return [];

  const servers: McpServerLaunch[] = [];
  for (const [name, entry] of block.children) {
    const launch = resolveServerLaunch({
      name,
      command: entry.children.get('command')?.value ?? null,
      url: entry.children.get('url')?.value ?? null,
      args: listIn(entry.children.get('args') ?? null),
      env: [...(entry.children.get('env')?.children.keys() ?? [])].sort(),
      disabled: entry.children.get('enabled')?.value === 'false',
    });
    if (launch === null) continue;
    const filter = filterIn(entry);
    servers.push(filter === undefined ? launch : { ...launch, filter });
  }
  return servers;
}

/**
 * Present and empty differ: Hermes registers nothing for an explicit `include: []`,
 * which is its installer's "uncheck everything", so absent and empty stay apart.
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

/** Hermes is a harness: each role in its config is a separate principal at the seam. */
function hostedIn(root: YamlBlock, path: string): HostedAgents {
  const roles = [...(blockAt(root, 'agents')?.children.keys() ?? [])];
  return {
    // Hermes executes its own roles rather than driving another product, so a model is not a runtime.
    runtimes: [],
    roles,
    hooks: [],
    federated: false,
    evidence: [path],
  };
}
