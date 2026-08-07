const ENV_KEYS = ['MEMNOX_USER', 'USER', 'LOGNAME', 'USERNAME'] as const;
const UNKNOWN = 'unknown';

/**
 * Who is resolving an approval, when they did not say.
 *
 * Read from the environment rather than `git config`, so the answer needs no
 * subprocess and works outside a repository. `--by` always wins — this is a
 * default that removes a flag from the common case, not an identity claim.
 */
export function resolveWhoAmI(env: NodeJS.ProcessEnv): string {
  for (const key of ENV_KEYS) {
    const value = env[key];
    if (value !== undefined && value.trim().length > 0) return value.trim();
  }
  return UNKNOWN;
}
