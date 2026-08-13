import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { CloudConfig } from './cloud-connection';

/**
 * Where a locally launched agent finds its credentials.
 *
 * A GUI-launched MCP client inherits no shell environment, so an exported
 * MEMNOX_AGENT_TOKEN never reaches it — the token has to live somewhere on disk
 * it can read on its own. Takes the home directory rather than reading it, so
 * tests write into a scratch directory.
 */
export interface AgentConfig {
  token?: string;
  url?: string;
  /** Set by `memnox login`; absent until a developer joins a control plane. */
  cloud?: CloudConfig;
}

const CONFIG_DIR = '.memnox';
const CONFIG_FILE = 'config.json';
/** Owner-only: the file holds a credential. */
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

export function agentConfigPath(homeDir: string): string {
  return join(homeDir, CONFIG_DIR, CONFIG_FILE);
}

export async function readAgentConfig(homeDir: string): Promise<AgentConfig> {
  try {
    return JSON.parse(await readFile(agentConfigPath(homeDir), 'utf8')) as AgentConfig;
  } catch {
    return {}; // No config yet — callers fall back to their own defaults.
  }
}

export async function writeAgentConfig(
  homeDir: string,
  config: AgentConfig,
): Promise<string> {
  const path = agentConfigPath(homeDir);
  await mkdir(dirname(path), { recursive: true, mode: DIR_MODE });
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, {
    encoding: 'utf8',
    mode: FILE_MODE,
  });
  return path;
}
