import { ENV_AGENT_NAME, ENV_POLICIES, readPolicyFiles, SESSION_VAR } from '@memnox/core';

import { ENV_AGENT_ROLE } from './tool-hook.constants';

/**
 * Where a seam finds the rules to evaluate against, with no daemon and no network: the
 * environment first, then the registry every other seam reads.
 */
export interface HookConfig {
  policyFiles: string[];
  /** Listed by the registry rather than named by this run, so a gone one is skippable. */
  fromRegistry: boolean;
  agentName?: string;
  /** The role a rule's `roles:` matches, when this agent was enrolled under one. */
  agentRole?: string;
  /** The session `memnox run` set, whose declared task a scope rule compares against. */
  sessionId?: string;
  /**
   * The agent's own session id, from the hook payload, where no run set one: the key a
   * task read from the person's prompt is kept under. Read for the task and nothing else.
   */
  hostSessionId?: string;
}

/**
 * Reading only the environment would install cleanly
 * and then govern nothing from a desktop icon.
 */
export async function readHookConfig(
  env: NodeJS.ProcessEnv,
  homeDir: string,
): Promise<HookConfig> {
  const named = env[ENV_POLICIES];
  return {
    policyFiles: await readPolicyFiles(named, homeDir),
    fromRegistry: named === undefined || named.trim().length === 0,
    ...pick('agentName', env[ENV_AGENT_NAME]),
    ...pick('agentRole', env[ENV_AGENT_ROLE]),
    ...pick('sessionId', env[SESSION_VAR]),
  };
}

function pick<TKey extends string>(
  key: TKey,
  value: string | undefined,
): Partial<Record<TKey, string>> {
  if (value === undefined || value.length === 0) return {};
  // A computed key widens to `string`, and TKey is the only key it can be.
  return { [key]: value } as Record<TKey, string>;
}
