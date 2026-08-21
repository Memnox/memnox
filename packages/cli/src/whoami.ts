const ENV_KEYS = ['MEMNOX_USER', 'USER', 'LOGNAME', 'USERNAME'] as const;
const UNKNOWN = 'unknown';

/** Read from the environment, so resolving an approval needs no subprocess. */
export function resolveWhoAmI(env: NodeJS.ProcessEnv): string {
  for (const key of ENV_KEYS) {
    const value = env[key];
    if (value !== undefined && value.trim().length > 0) return value.trim();
  }
  return UNKNOWN;
}
