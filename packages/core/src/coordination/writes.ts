import { TOOL_CLASS } from '../discovery/classify';
import { COMMAND_CLASS } from '../intercept/binary-class';
import { normalizeLeasePath } from './lease';

/**
 * Which actions take a lease: write-class and destructive only, so a read never waits.
 * Both class vocabularies are listed, since a shell action may carry either spelling.
 */

const WRITING: readonly string[] = [
  TOOL_CLASS.WRITE,
  TOOL_CLASS.DESTRUCTIVE,
  COMMAND_CLASS.DESTRUCTIVE,
  COMMAND_CLASS.PACKAGE_INSTALL,
];

export function takesLease(actionClass: string): boolean {
  return WRITING.includes(actionClass);
}

/**
 * The repository-relative path a command acts on, or null when it names none. Anything
 * not under the repository is declined rather than approximated into a surprise lease.
 */
export function leasePathFor(
  target: string | undefined,
  repoRoot: string,
  cwd: string,
): string | null {
  if (target === undefined || target.trim() === '') return null;
  // A host or a URL is not a path, and neither is a branch spelled with a slash.
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(target)) return null;

  const absolute = target.startsWith('/')
    ? target
    : `${cwd.replace(/\/+$/, '')}/${target}`;
  const root = repoRoot.replace(/\/+$/, '');
  if (absolute !== root && !absolute.startsWith(`${root}/`)) return null;

  return normalizeLeasePath(absolute.slice(root.length));
}

/**
 * The directory a write lands in, so later writes there renew one lease. Directory-ness
 * is asked of the caller, since `.eslintrc` is a file and `src/v1.2` is a directory.
 */
export function leaseScopeFor(
  path: string,
  isDirectory: (path: string) => boolean,
): string {
  if (path === '' || isDirectory(path)) return path;
  const cut = path.lastIndexOf('/');
  return cut === -1 ? '' : path.slice(0, cut);
}
