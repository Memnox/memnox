import { homedir } from 'node:os';
import {
  LocalGate,
  SESSION_VAR,
  SessionTasks,
  overlaysInForce,
  stateFactsInForce,
} from '@memnox/core';
import type { HookConfig } from './hook-config';
import { DEFAULT_AGENT_NAME } from './tool-hook.constants';

/** Null leaves the runtime as the only gate, which is what an unconfigured install has. */
export async function loadHookGate(
  config: HookConfig,
  home: string = homedir(),
  now: () => string = () => new Date().toISOString(),
): Promise<LocalGate | null> {
  if (config.policyFiles.length === 0) return null;

  /* Read here, at the moment of the decision. A freeze declared while an agent is
     already running has to bite the next command, not the next restart. */
  const overlays = await overlaysInForce(home);
  /* The task, for the same reason: a rule about scope has to compare against what
     somebody asked for at the moment they asked, not against a declaration read once
     at install time. Null when nothing was declared, which is most sessions. */
  const sessionId = process.env[SESSION_VAR];
  const task =
    sessionId === undefined ? null : await new SessionTasks(home).read(sessionId);

  return LocalGate.fromFiles(config.policyFiles, {
    agentName: config.agentName ?? DEFAULT_AGENT_NAME,
    ...(config.agentRole === undefined ? {} : { agentRole: config.agentRole }),
    task,
    stateFacts: stateFactsInForce(overlays, now()),
  });
}
