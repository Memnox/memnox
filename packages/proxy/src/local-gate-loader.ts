import { join } from 'node:path';
import { LocalGate, loadPolicySet, MEMNOX_HOME, readPolicyRegistry } from '@memnox/core';
import {
  ENV_AGENT_NAME,
  ENV_POLICIES,
  MCP_ACTION_PREFIX,
  POLICY_PATH_SEPARATOR,
} from './firewall.constants';

/** Where the registry of rule files this machine loads is kept. */
const REGISTRY_FILE = 'policies.json';

export interface LocalGateEnvironment {
  policies?: string;
  agentName?: string;
}

/**
 * The environment first, then the registry every other seam reads.
 *
 * Reading only the environment was a hole with a clean bill of health on top of it:
 * `mcp wrap` repoints every server at this binary, and an editor started from a dock
 * icon carries no environment, so the proxy came up with no rules and allowed
 * everything while the wiring check happily reported all servers routed. Routed is
 * not governed. The interceptors have always fallen back here; so does this now.
 */
export async function loadLocalGate(
  environment: LocalGateEnvironment,
  serverName: string,
  home: string,
  warn: (message: string) => void = () => undefined,
): Promise<LocalGate | null> {
  const files = await policyFiles(environment, home);
  if (files.length === 0) return null;

  /* Tolerant of a file that will not parse, because this binary stands in front of
     every MCP server the agent has: throwing here means the agent starts nothing at
     all, and one bad edit in an unrelated repository would take the whole machine
     down. The rules that did load still bind, and the ones that did not are named. */
  const set = await loadPolicySet(files);
  for (const broken of set.unreadable) {
    warn(
      `${broken.file} would not load, so its rules are not in force: ${broken.issues.length} problem(s)`,
    );
  }
  if (set.policies.length === 0 && set.unreadable.length > 0) {
    /* Every file was broken. Null leaves the static tool filters as the only gate,
       which is the same state as "no rules configured" and is reported as such —
       never silently, because a machine with rules it cannot read is not ungoverned
       by choice. */
    warn('no rule file loaded, so nothing is being gated here');
    return null;
  }

  return new LocalGate(set.policies, {
    agentName: environment.agentName ?? `${MCP_ACTION_PREFIX}:${serverName}`,
  });
}

async function policyFiles(
  environment: LocalGateEnvironment,
  home: string,
): Promise<string[]> {
  const configured = environment.policies;
  if (configured !== undefined && configured.trim().length > 0) {
    return configured
      .split(POLICY_PATH_SEPARATOR)
      .map((path) => path.trim())
      .filter((path) => path.length > 0);
  }
  return readPolicyRegistry(join(home, MEMNOX_HOME, REGISTRY_FILE));
}

export function localGateEnvironment(env: NodeJS.ProcessEnv): LocalGateEnvironment {
  return {
    policies: env[ENV_POLICIES],
    agentName: env[ENV_AGENT_NAME],
  };
}
