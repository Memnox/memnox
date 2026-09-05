import { join } from 'node:path';
import { MEMNOX_HOME } from '@memnox/core';

/**
 * Everything the CLI writes under `~/.memnox`, named in one place. The kernel profile
 * is why: `protect --os-guard` wrote it and `memnox run` looked for it, each spelling
 * the path itself, so renaming the file in one of them would have started every agent
 * outside the sandbox with nothing to say it had.
 */

const GUARD_DIR = 'guard';
const GUARD_PROFILE = 'memnox.sb';
const TRANSCRIPT_DIR = 'transcripts';
const BACKUP_DIR = 'backup';

export function guardProfilePath(home: string): string {
  return join(home, MEMNOX_HOME, GUARD_DIR, GUARD_PROFILE);
}

/** The Linux half of the same guard: a ruleset rather than a seatbelt profile. */
export function landlockRulesetPath(home: string): string {
  return join(home, MEMNOX_HOME, GUARD_DIR, 'landlock.json');
}

export function transcriptPathFor(home: string, sessionId: string): string {
  return join(home, MEMNOX_HOME, TRANSCRIPT_DIR, `${sessionId}.log`);
}

/** A config's own path, flattened: two clients may both ship a `settings.json`. */
export function backupPathFor(home: string, path: string): string {
  return join(home, MEMNOX_HOME, BACKUP_DIR, path.replace(/[/\\ ]/g, '_'));
}
