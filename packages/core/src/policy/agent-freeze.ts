import { agentIdFor } from '../discovery/agent';
import { OVERLAY_KIND } from './overlay';

// Spelled as the cloud's AGENT_SUBJECT_PREFIX, so a freeze on agent `payments` never reads as one on service `payments`.
export const AGENT_SUBJECT_PREFIX = 'agent:';

export const AGENT_FROZEN_REASON =
  'this agent is frozen across the workspace, so nothing it asks for runs until the freeze lifts or expires';

/** True when a freeze on this agent by name is among the state labels in force. */
export function agentFrozen(
  state: readonly string[] | undefined,
  agentName: string,
): boolean {
  if (state === undefined || state.length === 0) return false;
  // The console freezes an agent by its fleet id (`agt_claude-code`) and a seam runs as its name.
  const labels = [agentName, agentIdFor(agentName)].map((name) =>
    `${OVERLAY_KIND.FREEZE}:${AGENT_SUBJECT_PREFIX}${name}`.toLowerCase(),
  );
  return state.some((fact) => labels.includes(fact.toLowerCase()));
}
