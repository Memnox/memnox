import { TOOL_CLASS } from '../discovery/classify';
import { COMMAND_CLASS } from '../intercept/binary-class';
import { normalizeLeasePath } from './lease';

/**
 * Which actions take a lease, and which never do.
 *
 * Rule 2, and it is the one that decides whether people keep this turned on: two agents
 * reading one directory is normal and always was. A lease is consulted for write-class
 * and destructive work only, so nothing here can ever make a read wait.
 *
 * The class vocabulary is deliberately both: a resolved shell action carries a
 * `ToolClass` when a verb table named it and a `CommandClass` when the generic
 * classifier did, and a lease that fired for one spelling and not the other would be a
 * gate that closes on Tuesdays.
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
 * The repository-relative path a command acts on, or null when it names none.
 *
 * A target that is a host or a branch is not a path, and guessing at one would take a
 * lease nobody could predict — so anything that does not resolve under the repository
 * is declined rather than approximated. `..` is already null by `normalizeLeasePath`.
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
 * The path a session actually takes, given the file a command is about to write.
 *
 * A lease per file would be ten leases for one afternoon's work, and ten refusals for
 * the agent behind it. The directory is the unit a refactor collides on anyway, so a
 * write claims the directory it lands in and every later write in that directory is a
 * renewal rather than a second lease.
 *
 * The breadth is deliberate and is the cost of rule 1: a developer has to be able to
 * predict what they took, and "the directory I wrote in" is predictable in a way that
 * "the smallest tree covering everything I have touched so far" is not.
 *
 * Whether the path is a directory is asked of the caller rather than guessed from a
 * dot in the name — `.eslintrc` is a file and `src/v1.2` is a directory.
 */
export function leaseScopeFor(
  path: string,
  isDirectory: (path: string) => boolean,
): string {
  if (path === '' || isDirectory(path)) return path;
  const cut = path.lastIndexOf('/');
  return cut === -1 ? '' : path.slice(0, cut);
}
