import { LocalGate } from '@memnox/local-gate';
import type { HookConfig } from './hook-config';
import { DEFAULT_AGENT_NAME } from './tool-hook.constants';

/** Null leaves the runtime as the only gate, which is what an unconfigured install has. */
export async function loadHookGate(config: HookConfig): Promise<LocalGate | null> {
  if (config.policyFiles.length === 0) return null;

  return LocalGate.fromFiles(config.policyFiles, {
    agentName: config.agentName ?? DEFAULT_AGENT_NAME,
  });
}
