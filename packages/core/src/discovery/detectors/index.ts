import { dirname, join } from 'node:path';
import { DISCOVERED_AGENT_KIND, SURFACE_KIND } from '../discovery.constants';
import { ConfigDetector, type ConfigDetectorSpec } from './config-detector';
import type { AgentDetector } from './detector';
import { CodexDetector } from './codex-detector';
import { HermesDetector } from './hermes-detector';
import { OpenClawDetector } from './openclaw-detector';
import { RufloDetector } from './ruflo-detector';

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

/**
 * Products whose config needs real parsing. Codex is TOML, Hermes is YAML, OpenClaw is
 * JSON with comments, and Ruflo lives beside the work rather than in the home
 * directory. The data-driven detector reads servers with a JSON parser, so against any
 * of these it would find nothing and say nothing — which is worse than not trying.
 */
const PARSING_DETECTORS: readonly AgentDetector[] = [
  new CodexDetector(),
  new HermesDetector(),
  new OpenClawDetector(),
  new RufloDetector(),
];

export const DEFAULT_DETECTORS: readonly AgentDetector[] = [
  ...DETECTOR_SPECS.map((spec) => new ConfigDetector(spec)),
  ...PARSING_DETECTORS,
];

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
  /* A product with its own parser is not in the spec list, so its directory is added
     here: a harness adds agents without touching any client config, and Codex's
     config would otherwise be watched by nothing at all. */
  for (const relative of PARSED_CONFIG_DIRS) paths.add(join(home, relative));
  return [...paths].sort();
}

/**
 * Directories the parsing detectors read, watched so a new server or role is an event,
 * plus the directories definitions are installed into.
 *
 * A definition directory is watched for the same reason a config is: what an agent may
 * do changed and no config records it. `~/.claude` is already covered by the bare
 * `.claude.json` above, and the rest are here because nothing else on this list would
 * bring them in.
 */
const PARSED_CONFIG_DIRS: readonly string[] = [
  '.hermes',
  '.openclaw',
  '.claude-flow',
  '.codex',
  '.gemini/agents',
  '.qwen/agents',
  '.zcode/agents',
  '.github/agents',
  '.copilot/agents',
  '.config/opencode/agents',
];

export * from './detector';
export * from './config-detector';
export * from './mcp-config';
export * from './yaml-block';
export * from './toml-tables';
export * from './codex-detector';
export * from './hermes-detector';
export * from './openclaw-detector';
export * from './ruflo-detector';
