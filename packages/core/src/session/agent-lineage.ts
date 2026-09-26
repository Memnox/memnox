/**
 * Which agents started this one. An agent that launches another, Codex from Claude Code's
 * shell or a nested `memnox run`, hands it its environment, and the environment is what
 * says so: the parent's own marker, and the chain `memnox run` writes down.
 */
import { DISCOVERED_AGENT_KIND } from '../discovery/discovery.constants';

/** The chain of agents above this one, outermost first, as `memnox run` passes it on. */
export const ENV_PARENT_AGENTS = 'MEMNOX_PARENT_AGENTS';

/** The variable each agent sets for what it runs, and the agent it names. */
const MARKER_AGENTS: Readonly<Record<string, string>> = {
  CLAUDECODE: DISCOVERED_AGENT_KIND.CLAUDE_CODE,
  CODEX_SANDBOX: DISCOVERED_AGENT_KIND.CODEX_CLI,
  CURSOR_AGENT: DISCOVERED_AGENT_KIND.CURSOR,
};

/** The agent the environment's markers name, or null where none does. */
export function agentOfMarkers(env: NodeJS.ProcessEnv): string | null {
  const marker = Object.keys(MARKER_AGENTS).find((name) => (env[name] ?? '') !== '');
  return marker === undefined ? null : (MARKER_AGENTS[marker] ?? null);
}

/**
 * Every agent above `self`: the chain written down, then any agent whose marker is set and
 * is not `self`, since an agent's own marker is set in its own tools too.
 */
export function parentAgentsOf(env: NodeJS.ProcessEnv, self: string): string[] {
  const chain = (env[ENV_PARENT_AGENTS] ?? '')
    .split(',')
    .map((each) => each.trim())
    .filter((each) => each !== '');
  const marked = agentOfMarkers(env);
  const parents = marked === null ? chain : [...chain, marked];
  return [...new Set(parents)].filter((each) => each !== self);
}

/** The chain a child is handed: everything above this agent, then this agent. */
export function lineageFor(env: NodeJS.ProcessEnv, self: string): string {
  return [...parentAgentsOf(env, self), self].join(',');
}
