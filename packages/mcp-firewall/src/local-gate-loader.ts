import { LocalGate } from '@memnox/local-gate';
import {
  ENV_AGENT_NAME,
  ENV_POLICIES,
  MCP_ACTION_PREFIX,
  POLICY_PATH_SEPARATOR,
} from './firewall.constants';

export interface LocalGateEnvironment {
  policies?: string;
  agentName?: string;
}

/**
 * Builds the in-process gate from the environment. Null means no local rules
 * were configured, which leaves the runtime as the only gate — the behaviour
 * every existing deployment already has.
 *
 * An unreadable or invalid policy file throws: a firewall that silently runs
 * with no rules is worse than one that refuses to start.
 */
export async function loadLocalGate(
  environment: LocalGateEnvironment,
  serverName: string,
): Promise<LocalGate | null> {
  const configured = environment.policies;
  if (configured === undefined || configured.trim().length === 0) return null;

  const files = configured
    .split(POLICY_PATH_SEPARATOR)
    .map((path) => path.trim())
    .filter((path) => path.length > 0);
  if (files.length === 0) return null;

  return LocalGate.fromFiles(files, {
    agentName: environment.agentName ?? `${MCP_ACTION_PREFIX}:${serverName}`,
  });
}

export function localGateEnvironment(env: NodeJS.ProcessEnv): LocalGateEnvironment {
  return {
    policies: env[ENV_POLICIES],
    agentName: env[ENV_AGENT_NAME],
  };
}
