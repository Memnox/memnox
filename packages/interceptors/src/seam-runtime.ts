import { homedir } from 'node:os';
import { HookAuthorizer } from './hook-authorizer';
import { readHookConfig } from './hook-config';
import { loadHookGate } from './hook-gate-loader';
import { ENV_POLICIES } from './tool-hook.constants';

/** stderr is the safe side channel — stdout belongs to whatever protocol is speaking. */
export const log = (message: string): void => {
  process.stderr.write(`[memnox] ${message}\n`);
};

// The environment first, then what was written to config: shared by every local interceptor.
export async function buildAuthorizer(): Promise<HookAuthorizer> {
  const config = await readHookConfig(process.env, homedir());
  const gate = await loadHookGate(config);
  if (gate === null) {
    log(`no gate configured — set ${ENV_POLICIES}`);
  }

  return new HookAuthorizer({
    ...(gate === null ? {} : { gate }),
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
