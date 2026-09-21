import { join } from 'node:path';
import { DISCOVERED_AGENT_KIND, SURFACE_KIND } from '../discovery.constants';
import { TOML_SERVER_TABLES } from '../mcp-keys';
import type { MachineReader } from '../ports';
import type { McpServerLaunch } from '../surface';
import { buildDetectedAgent, buildMcpSurfaces, buildSurfaces } from './detected-agent';
import type { AgentDetector, DetectionResult } from './detector';
import { resolveServerLaunch } from './mcp-config';
import {
  childTablesOf,
  keyNamesAt,
  listAt,
  parseTomlTables,
  stringAt,
  type TomlTables,
} from './toml-tables';

/**
 * Codex writes TOML, so it has its own detector: the data-driven one reads servers with
 * a JSON parser and against TOML would find nothing while reporting no fault.
 */
const CONFIG = '.codex/config.toml';
const DIRECTORY = '.codex';

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
    const agent = buildDetectedAgent({
      kind: this.kind,
      configPaths: found,
      clients: ['Codex CLI'],
      reader,
      now,
    });

    const evidence = hasConfig ? configPath : directory;
    const servers = hasConfig
      ? codexServers(parseTomlTables(await reader.read(configPath)))
      : [];
    const surfaces = [
      ...buildSurfaces(
        agent.id,
        [SURFACE_KIND.SHELL, SURFACE_KIND.FILESYSTEM, SURFACE_KIND.GIT],
        evidence,
      ),
      ...buildMcpSurfaces(agent.id, configPath, servers),
    ];
    return { agent, surfaces };
  }
}

/** Launch lines and credential names, from either spelling of the servers table. */
function codexServers(parsed: TomlTables): McpServerLaunch[] {
  const servers: McpServerLaunch[] = [];
  const seen = new Set<string>();

  for (const table of TOML_SERVER_TABLES) {
    for (const name of childTablesOf(parsed, table)) {
      if (seen.has(name)) continue;
      const path = `${table}.${name}`;
      const launch = resolveServerLaunch({
        name,
        command: stringAt(parsed, path, 'command'),
        url: stringAt(parsed, path, 'url'),
        args: listAt(parsed, path, 'args'),
        env: keyNamesAt(parsed, path, 'env'),
        disabled: stringAt(parsed, path, 'enabled') === 'false',
      });
      if (launch === null) continue;
      seen.add(name);
      servers.push(launch);
    }
  }
  return servers;
}
