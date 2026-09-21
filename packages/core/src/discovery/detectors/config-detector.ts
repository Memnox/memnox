import { join } from 'node:path';
import type { DiscoveredAgentKind, SurfaceKind } from '../discovery.constants';
import type { MachineReader } from '../ports';
import type { McpServerLaunch, Surface } from '../surface';
import { buildDetectedAgent, buildMcpSurfaces, buildSurfaces } from './detected-agent';
import type { AgentDetector, DetectionContext, DetectionResult } from './detector';
import { readMcpServers } from './mcp-config';

/**
 * The detector most agents need: a config path, a JSON servers key, and nothing else.
 * A client that keeps JSON is a row of data; one needing real parsing gets its own module.
 */
export interface ConfigDetectorSpec {
  kind: DiscoveredAgentKind;
  layoutVersion: string;
  /** Paths relative to the home directory; the first that exists proves the agent. */
  configPaths: readonly string[];
  /** The app hosting it, as the reader would name it. */
  clients: readonly string[];
  /** Surfaces this product has by construction, whatever its config says. */
  inherentSurfaces: readonly SurfaceKind[];
  /** Set when this product's config file is also where its MCP servers live. */
  mcpConfigPath?: string;
}

export class ConfigDetector implements AgentDetector {
  readonly kind: string;
  readonly layoutVersion: string;

  constructor(private readonly spec: ConfigDetectorSpec) {
    this.kind = spec.kind;
    this.layoutVersion = spec.layoutVersion;
  }

  // Every one of these products reads only its home directory, so the context is unused.
  async detect(
    reader: MachineReader,
    now: string,
    _context?: DetectionContext,
  ): Promise<DetectionResult | null> {
    const home = reader.homeDir();
    const found: string[] = [];
    for (const relative of this.spec.configPaths) {
      const path = join(home, relative);
      if (await reader.exists(path)) found.push(path);
    }
    if (found.length === 0) return null;

    const agent = buildDetectedAgent({
      kind: this.spec.kind,
      configPaths: found,
      clients: [...this.spec.clients],
      reader,
      now,
    });
    const surfaces = [
      ...buildSurfaces(agent.id, this.spec.inherentSurfaces, found[0] ?? home),
      ...(await this.mcpSurfaces(reader, agent.id)),
    ];
    return { agent, surfaces };
  }

  /** The launch lines travel so the tools can be asked for over the protocol. */
  private async mcpSurfaces(reader: MachineReader, agentId: string): Promise<Surface[]> {
    const mcpPath = this.spec.mcpConfigPath;
    if (mcpPath === undefined) return [];
    const full = join(reader.homeDir(), mcpPath);
    const servers: McpServerLaunch[] = readMcpServers(await reader.read(full));
    return buildMcpSurfaces(agentId, full, servers);
  }
}
