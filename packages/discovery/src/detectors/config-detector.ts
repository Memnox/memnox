import { join } from 'node:path';
import type { DiscoveredAgent } from '../agent';
import type { DiscoveredAgentKind, SurfaceKind } from '../discovery.constants';
import type { MachineReader } from '../ports';
import type { Surface } from '../surface';
import type { AgentDetector, DetectionResult } from './detector';
import { readMcpServers } from './mcp-config';

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

/**
 * Most detectors differ only in which files to look at and what the product can do
 * by construction, so they are data. A product needing real parsing gets its own module.
 */
export class ConfigDetector implements AgentDetector {
  readonly kind: string;
  readonly layoutVersion: string;

  constructor(private readonly spec: ConfigDetectorSpec) {
    this.kind = spec.kind;
    this.layoutVersion = spec.layoutVersion;
  }

  async detect(reader: MachineReader, now: string): Promise<DetectionResult | null> {
    const home = reader.homeDir();
    const found: string[] = [];
    for (const relative of this.spec.configPaths) {
      const path = join(home, relative);
      if (await reader.exists(path)) found.push(path);
    }
    if (found.length === 0) return null;

    const agent: DiscoveredAgent = {
      id: `agt_${this.spec.kind}`,
      kind: this.spec.kind,
      configPaths: found,
      clients: [...this.spec.clients],
      ownerHint: reader.userName(),
      firstSeen: now,
      lastSeen: now,
    };

    const evidence = found[0] ?? home;
    const surfaces: Surface[] = this.spec.inherentSurfaces.map((kind) => ({
      agentId: agent.id,
      kind,
      detectedFrom: evidence,
    }));

    const mcpPath = this.spec.mcpConfigPath;
    if (mcpPath !== undefined) {
      const full = join(home, mcpPath);
      const servers = readMcpServers(await reader.read(full));
      if (servers.length > 0) {
        surfaces.push({ agentId: agent.id, kind: 'mcp', detectedFrom: full, tools: [] });
      }
    }

    return { agent, surfaces };
  }
}
