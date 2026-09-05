import { dirname, join } from 'node:path';
import { DISCOVERED_AGENT_KIND, SURFACE_KIND } from '../discovery.constants';
import { ConfigDetector, type ConfigDetectorSpec } from './config-detector';
import type { AgentDetector } from './detector';

/**
 * A versioned, separately releasable set with the layout revision each was written
 * against, because every one of them depends on somebody else's undocumented format.
 */
const DETECTOR_SPECS: readonly ConfigDetectorSpec[] = [
  {
    kind: DISCOVERED_AGENT_KIND.CLAUDE_CODE,
    layoutVersion: '2026-08',
    configPaths: ['.claude.json', '.claude/settings.json'],
    clients: ['Claude Code'],
    inherentSurfaces: [
      SURFACE_KIND.SHELL,
      SURFACE_KIND.FILESYSTEM,
      SURFACE_KIND.GIT,
      SURFACE_KIND.NETWORK,
    ],
    mcpConfigPath: '.claude.json',
  },
  {
    kind: DISCOVERED_AGENT_KIND.CLAUDE_DESKTOP,
    layoutVersion: '2026-08',
    configPaths: [
      'Library/Application Support/Claude/claude_desktop_config.json',
      '.config/Claude/claude_desktop_config.json',
    ],
    clients: ['Claude Desktop'],
    inherentSurfaces: [SURFACE_KIND.NETWORK],
    mcpConfigPath: 'Library/Application Support/Claude/claude_desktop_config.json',
  },
  {
    kind: DISCOVERED_AGENT_KIND.CURSOR,
    layoutVersion: '2026-08',
    configPaths: ['.cursor/mcp.json', '.cursor'],
    clients: ['Cursor'],
    inherentSurfaces: [SURFACE_KIND.SHELL, SURFACE_KIND.FILESYSTEM, SURFACE_KIND.NETWORK],
    mcpConfigPath: '.cursor/mcp.json',
  },
  {
    kind: DISCOVERED_AGENT_KIND.CODEX_CLI,
    layoutVersion: '2026-08',
    configPaths: ['.codex/config.toml', '.codex'],
    clients: ['Codex CLI'],
    inherentSurfaces: [SURFACE_KIND.SHELL, SURFACE_KIND.FILESYSTEM, SURFACE_KIND.GIT],
  },
  {
    kind: DISCOVERED_AGENT_KIND.CLINE,
    layoutVersion: '2026-08',
    configPaths: ['.cline/settings.json'],
    clients: ['Cline'],
    inherentSurfaces: [SURFACE_KIND.SHELL, SURFACE_KIND.FILESYSTEM],
    mcpConfigPath: '.cline/settings.json',
  },
  {
    kind: DISCOVERED_AGENT_KIND.VS_CODE,
    layoutVersion: '2026-08',
    configPaths: ['.vscode/mcp.json'],
    clients: ['VS Code'],
    inherentSurfaces: [SURFACE_KIND.FILESYSTEM, SURFACE_KIND.NETWORK],
    mcpConfigPath: '.vscode/mcp.json',
  },
];

export const DEFAULT_DETECTORS: readonly AgentDetector[] = DETECTOR_SPECS.map(
  (spec) => new ConfigDetector(spec),
);

/**
 * The directories whose change means an agent's reach may have changed. Directories
 * rather than files, because a config that does not exist yet cannot be watched and a
 * newly added MCP config is exactly the case worth catching.
 */
export function watchablePaths(home: string): string[] {
  const paths = new Set<string>();
  for (const spec of DETECTOR_SPECS) {
    for (const relative of spec.configPaths) {
      paths.add(relative.includes('/') ? dirname(join(home, relative)) : home);
    }
  }
  return [...paths].sort();
}

export * from './detector';
export * from './config-detector';
export * from './mcp-config';
