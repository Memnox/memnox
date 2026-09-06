import { join } from 'node:path';
import { readPolicyRegistry } from '@memnox/core';
import {
  ENV_AGENT_NAME,
  ENV_AGENT_ROLE,
  ENV_POLICIES,
  POLICY_PATH_SEPARATOR,
} from './tool-hook.constants';

const CONFIG_DIR = '.memnox';
const REGISTRY_FILE = 'policies.json';

export interface HookConfig {
  policyFiles: string[];
  agentName?: string;
  /** The role a rule's `roles:` matches, when this agent was enrolled under one. */
  agentRole?: string;
}

/**
 * The environment first, then the registry on disk. An agent launched from a desktop
 * icon inherits no shell, so reading only the environment would install cleanly and
 * then govern nothing — which is worse than not installing.
 */
export async function readHookConfig(
  env: NodeJS.ProcessEnv,
  homeDir: string,
): Promise<HookConfig> {
  const configured = env[ENV_POLICIES];

  return {
    policyFiles:
      configured === undefined || configured.trim().length === 0
        ? await readPolicyRegistry(join(homeDir, CONFIG_DIR, REGISTRY_FILE))
        : splitPaths(configured),
    ...pick('agentName', env[ENV_AGENT_NAME]),
    ...pick('agentRole', env[ENV_AGENT_ROLE]),
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
