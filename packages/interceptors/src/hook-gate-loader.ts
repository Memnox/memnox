import { homedir } from 'node:os';
import { LocalGate, readOverlays, stateFactsInForce } from '@memnox/core';
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
  const overlays = await readOverlays(home);
  return LocalGate.fromFiles(config.policyFiles, {
    agentName: config.agentName ?? DEFAULT_AGENT_NAME,
    stateFacts: stateFactsInForce(overlays, now()),
  });
}
