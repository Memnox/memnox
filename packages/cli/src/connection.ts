import type { AgentConfig } from './agent-config';
import { DEFAULT_BASE_URL } from './defaults';

/** How a command reaches credentials its flags did not carry. */
export type StoredConfigReader = () => Promise<AgentConfig>;

export const ENV_AGENT_TOKEN = 'MEMNOX_AGENT_TOKEN';
export const ENV_RUNTIME_URL = 'MEMNOX_URL';

/** What a command was told on the command line; every field is optional. */
export interface ConnectionFlags {
  url?: string;
  token?: string;
  adminToken?: string;
}

export interface ResolvedConnection {
  url: string;
  token?: string;
  adminToken?: string;
  /** Where the token came from, so a command can say so instead of looking magic. */
  tokenSource?: 'flag' | 'environment' | 'config';
}

/**
 * Flag, then environment, then the token `memnox setup` stored on disk. Pasting
 * a token into every invocation is the single thing that made the CLI tedious,
 * and the file is already how a locally launched agent authenticates.
 *
 * Environment beats the file on purpose: that is how CI and the MCP firewall
 * override a developer's machine-local identity.
 */
export function resolveConnection(
  flags: ConnectionFlags,
  stored: AgentConfig,
  env: NodeJS.ProcessEnv,
): ResolvedConnection {
  const envToken = env[ENV_AGENT_TOKEN];
  const token = flags.token ?? envToken ?? stored.token;

  return {
    url: flags.url ?? env[ENV_RUNTIME_URL] ?? stored.url ?? DEFAULT_BASE_URL,
    ...(token === undefined ? {} : { token }),
    ...(flags.adminToken === undefined ? {} : { adminToken: flags.adminToken }),
    ...(token === undefined ? {} : { tokenSource: sourceOf(flags.token, envToken) }),
  };
}

function sourceOf(
  flagToken: string | undefined,
  envToken: string | undefined,
): ResolvedConnection['tokenSource'] {
  if (flagToken !== undefined) return 'flag';
  if (envToken !== undefined) return 'environment';
  return 'config';
}

const CONNECTION_REFUSED = ['ECONNREFUSED', 'fetch failed', 'Failed to fetch'];

/**
 * Turns "fetch failed" into something a person can act on. A runtime that is
 * simply not running is by far the most common first-run failure, and the raw
 * cause names neither the address nor the fix.
 */
export function describeConnectionFailure(err: unknown, url: string): string | null {
  const message =
    err instanceof Error ? `${err.message} ${String(err.cause ?? '')}` : String(err);
  if (!CONNECTION_REFUSED.some((needle) => message.includes(needle))) return null;
  return [
    `Cannot reach the Memnox runtime at ${url}.`,
    '',
    'Start it with:  memnox serve',
    'Or point at another one:  --url http://host:port',
  ].join('\n');
}
