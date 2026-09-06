import { join } from 'node:path';
import type { DiscoveredAgent } from '../agent';
import { DISCOVERED_AGENT_KIND, SURFACE_KIND } from '../discovery.constants';
import type { MachineReader } from '../ports';
import type { McpServerLaunch, Surface } from '../surface';
import type { AgentDetector, DetectionResult } from './detector';
import {
  childTablesOf,
  keyNamesAt,
  listAt,
  parseTomlTables,
  stringAt,
  type TomlTables,
} from './toml-tables';

const CONFIG = '.codex/config.toml';
const DIRECTORY = '.codex';

/** Where Codex declares its servers. The older spelling still appears in the wild. */
const SERVER_TABLES: readonly string[] = ['mcp_servers', 'mcpServers'];

/**
 * Codex writes TOML, so it cannot share the data-driven detector: that one reads a
 * config's servers with a JSON parser, and against TOML it finds nothing and says
 * nothing, which is how a Codex machine came to be reported with no servers at all.
 */
export class CodexDetector implements AgentDetector {
  readonly kind = DISCOVERED_AGENT_KIND.CODEX_CLI;
  readonly layoutVersion = '2026-09';

  async detect(reader: MachineReader, now: string): Promise<DetectionResult | null> {
    const home = reader.homeDir();
    const configPath = join(home, CONFIG);
    const directory = join(home, DIRECTORY);
    const hasConfig = await reader.exists(configPath);
    if (!hasConfig && !(await reader.exists(directory))) return null;

    const found = hasConfig ? [configPath, directory] : [directory];
    const agent: DiscoveredAgent = {
      id: `agt_${this.kind}`,
      kind: this.kind,
      configPaths: found.filter(Boolean),
      clients: ['Codex CLI'],
      ownerHint: reader.userName(),
      firstSeen: now,
      lastSeen: now,
    };

    const evidence = found[0] as string;
    const surfaces: Surface[] = [
      SURFACE_KIND.SHELL,
      SURFACE_KIND.FILESYSTEM,
      SURFACE_KIND.GIT,
    ].map((kind) => ({ agentId: agent.id, kind, detectedFrom: evidence }));

    const servers = hasConfig
      ? codexServers(parseTomlTables(await reader.read(configPath)))
      : [];
    if (servers.length > 0) {
      surfaces.push({
        agentId: agent.id,
        kind: SURFACE_KIND.MCP,
        detectedFrom: configPath,
        tools: [],
        servers,
      });
    }

    return { agent, surfaces };
  }
}

/** Launch lines and credential names. Never a value, from either spelling of `env`. */
function codexServers(parsed: TomlTables): McpServerLaunch[] {
  const servers: McpServerLaunch[] = [];
  const seen = new Set<string>();

  for (const table of SERVER_TABLES) {
    for (const name of childTablesOf(parsed, table)) {
      if (seen.has(name)) continue;
      const path = `${table}.${name}`;
      const command = stringAt(parsed, path, 'command');
      const url = stringAt(parsed, path, 'url');
      // An HTTP upstream has no launch line; it is still a server and is still named.
      if (command === null && url === null) continue;
      seen.add(name);
      servers.push({
        name,
        command: command ?? 'http',
        args: command === null ? [url as string] : listAt(parsed, path, 'args'),
        env: keyNamesAt(parsed, path, 'env'),
        ...(stringAt(parsed, path, 'enabled') === 'false' ? { disabled: true } : {}),
      });
    }
  }
  return servers;
}
