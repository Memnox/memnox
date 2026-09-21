import { homedir } from 'node:os';
import { delimiter, join, sep } from 'node:path';
import { MEMNOX_HOME } from '../config/config';

/**
 * The environment for a git call Memnox makes about itself. A seam that asked the git on
 * PATH met its own interceptor, which asked again: one `git` became hundreds of processes.
 */

/** Where the interceptors live under the Memnox home, every entry the one wrapper. */
export const INTERCEPTOR_DIR = 'bin';

export function interceptorDirFor(home: string): string {
  return join(home, MEMNOX_HOME, INTERCEPTOR_DIR);
}

/** Any home's wrappers, since a process given another HOME still inherits the person's PATH. */
const INTERCEPTOR_SUFFIX = `${sep}${MEMNOX_HOME}${sep}${INTERCEPTOR_DIR}`;

function isInterceptorDir(entry: string, ours: string): boolean {
  const trimmed = entry.endsWith(sep) ? entry.slice(0, -1) : entry;
  return trimmed === ours || trimmed.endsWith(INTERCEPTOR_SUFFIX);
}

/** PATH without our directory, so what runs is the real binary rather than the gate. */
export function realPath(path: string, home: string): string {
  const ours = interceptorDirFor(home);
  return path
    .split(delimiter)
    .filter((entry) => entry !== '' && !isInterceptorDir(entry, ours))
    .join(delimiter);
}

/** Only for Memnox's own lookups: a command an agent ran keeps the PATH it was given. */
export function ownProcessEnv(
  home: string = homedir(),
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return { ...env, PATH: realPath(env['PATH'] ?? '', home) };
}
