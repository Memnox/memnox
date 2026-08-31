import { homedir } from 'node:os';
import { MemnoxClient } from '@memnox/sdk';
import { HookAuthorizer } from './hook-authorizer';
import { readHookConfig } from './hook-config';
import { loadHookGate } from './hook-gate-loader';
import { ENV_POLICIES, ENV_RUNTIME_URL } from './tool-hook.constants';

/** stderr is the safe side channel — stdout belongs to whatever protocol is speaking. */
export const log = (message: string): void => {
  process.stderr.write(`[memnox] ${message}\n`);
};

/**
 * The environment first, then what `memnox setup` wrote. Shared by all three local
 * seams, because a seam that only read the environment would install cleanly and then
 * govern nothing.
 */
export async function buildAuthorizer(): Promise<HookAuthorizer> {
  const config = await readHookConfig(process.env, homedir());
  const gate = await loadHookGate(config);
  const { runtimeUrl, agentToken } = config;

  if (gate === null && (runtimeUrl === undefined || agentToken === undefined)) {
    log(
      `no gate configured — run "memnox setup", or set ${ENV_POLICIES}/${ENV_RUNTIME_URL}`,
    );
  }

  return new HookAuthorizer({
    ...(gate === null ? {} : { gate }),
    ...(runtimeUrl === undefined || agentToken === undefined
      ? {}
      : { client: new MemnoxClient({ baseUrl: runtimeUrl, token: agentToken }) }),
    failOpen: config.failOpen,
    log,
  });
}

export async function readStdin(): Promise<string> {
  const chunks: string[] = [];
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) chunks.push(String(chunk));
  return chunks.join('');
}
