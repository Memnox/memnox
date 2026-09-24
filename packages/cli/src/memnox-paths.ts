import { join } from 'node:path';
import { MEMNOX_HOME } from '@memnox/core';

/**
 * Everything the CLI writes under `~/.memnox`, named in one place, because a path spelled
 * at two call sites is one that will disagree with itself.
 */

const GUARD_DIR = 'guard';
const GUARD_PROFILE = 'memnox.sb';
const TRANSCRIPT_DIR = 'transcripts';
const BACKUP_DIR = 'backup';
const LANDLOCK_RULESET = 'landlock.json';
const SESSION_GUARD_DIR = 'sessions';
const EGRESS_STATE = 'egress.json';

export function guardProfilePath(home: string): string {
  return join(home, MEMNOX_HOME, GUARD_DIR, GUARD_PROFILE);
}

/** The Linux half of the same guard: a ruleset rather than a seatbelt profile. */
export function landlockRulesetPath(home: string): string {
  return join(home, MEMNOX_HOME, GUARD_DIR, LANDLOCK_RULESET);
}

/** One untrusted session's own profile or plan, removed when the session ends. */
export function sessionGuardPath(
  home: string,
  sessionId: string,
  extension: string,
): string {
  return join(
    home,
    MEMNOX_HOME,
    GUARD_DIR,
    SESSION_GUARD_DIR,
    `${sessionId}.${extension}`,
  );
}

/** Where the daemon says which port its egress proxy took, so `memnox run` can point at it. */
export function egressStatePath(home: string): string {
  return join(home, MEMNOX_HOME, EGRESS_STATE);
}

export function transcriptPathFor(home: string, sessionId: string): string {
  return join(home, MEMNOX_HOME, TRANSCRIPT_DIR, `${sessionId}.log`);
}

/** A config's own path, flattened: two clients may both ship a `settings.json`. */
export function backupPathFor(home: string, path: string): string {
  return join(home, MEMNOX_HOME, BACKUP_DIR, path.replace(/[/\\ ]/g, '_'));
}

/**
 * A path as a person would say it, with their home written `~`, for screens rather than
 * opening a file. Left alone outside this home, since a `~` that is not the reader's misleads.
 */
export function underHome(path: string, home: string): string {
  if (home === '' || !path.startsWith(home)) return path;
  const rest = path.slice(home.length);
  if (rest !== '' && rest[0] !== '/' && rest[0] !== '\\') return path;
  return `~${rest}`;
}
