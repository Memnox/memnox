import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readPolicyRegistry } from '@memnox/local-gate';
import {
  ENV_AGENT_NAME,
  ENV_AGENT_TOKEN,
  ENV_FAIL_OPEN,
  ENV_POLICIES,
  ENV_RUNTIME_URL,
  POLICY_PATH_SEPARATOR,
} from './tool-hook.constants';

const CONFIG_DIR = '.memnox';
const CONFIG_FILE = 'config.json';
const REGISTRY_FILE = 'policies.json';

export interface HookConfig {
  policyFiles: string[];
  runtimeUrl?: string;
  agentToken?: string;
  agentName?: string;
  failOpen: boolean;
}

/**
 * The environment first, then what `memnox setup` wrote. An agent launched from a
 * desktop icon inherits no shell, so a seam that only read the environment would
 * install cleanly and then govern nothing — which is worse than not installing.
 */
export async function readHookConfig(
  env: NodeJS.ProcessEnv,
  homeDir: string,
): Promise<HookConfig> {
  const stored = await readAgentConfig(homeDir);
  const configured = env[ENV_POLICIES];

  return {
    policyFiles:
      configured === undefined || configured.trim().length === 0
        ? await readPolicyRegistry(join(homeDir, CONFIG_DIR, REGISTRY_FILE))
        : splitPaths(configured),
    ...pick('runtimeUrl', env[ENV_RUNTIME_URL] ?? stored.url),
    ...pick('agentToken', env[ENV_AGENT_TOKEN] ?? stored.token),
    ...pick('agentName', env[ENV_AGENT_NAME]),
    failOpen: env[ENV_FAIL_OPEN] === 'true',
  };
}

function splitPaths(value: string): string[] {
  return value
    .split(POLICY_PATH_SEPARATOR)
    .map((path) => path.trim())
    .filter((path) => path.length > 0);
}

function pick<TKey extends string>(
  key: TKey,
  value: string | undefined,
): Partial<Record<TKey, string>> {
  if (value === undefined || value.length === 0) return {};
  return { [key]: value } as Record<TKey, string>;
}

interface StoredAgentConfig {
  token?: string;
  url?: string;
}

async function readAgentConfig(homeDir: string): Promise<StoredAgentConfig> {
  try {
    const raw = await readFile(join(homeDir, CONFIG_DIR, CONFIG_FILE), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return {};
    return parsed as StoredAgentConfig;
  } catch {
    // No config yet is the ordinary local-only case, not an error.
    return {};
  }
}
