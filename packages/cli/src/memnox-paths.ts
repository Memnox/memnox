import { join } from 'node:path';
import { MEMNOX_HOME, TRANSCRIPT_SUFFIX, TRANSCRIPTS_DIR } from '@memnox/core';

/**
 * Everything the CLI writes under `~/.memnox`, named in one place, because a path spelled
 * at two call sites is one that will disagree with itself.
 */

const GUARD_DIR = 'guard';
const GUARD_PROFILE = 'memnox.sb';
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
  return join(home, MEMNOX_HOME, TRANSCRIPTS_DIR, `${sessionId}${TRANSCRIPT_SUFFIX}`);
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

const VOICE_DIR = 'voice';
const CONVERSATION_FILE = 'conversation.json';

/** The brain's conversation, kept so a follow up minutes later resumes rather than starts over. */
export function conversationPath(home: string): string {
  return join(home, MEMNOX_HOME, VOICE_DIR, CONVERSATION_FILE);
}

const VOICE_BRAIN_FILE = 'brain.json';
const VOICE_AGENTS_FILE = 'agents.json';

/** Which agent the voice thinks with, chosen in the Mac app or found by checking which answers. */
export function voiceBrainPath(home: string): string {
  return join(home, MEMNOX_HOME, VOICE_DIR, VOICE_BRAIN_FILE);
}

/** What each agent said when last asked to be the voice, for the Mac app's settings. */
export function voiceAgentsPath(home: string): string {
  return join(home, MEMNOX_HOME, VOICE_DIR, VOICE_AGENTS_FILE);
}

const KOKORO_VOICE_FILE = 'kokoro-voice.json';
const REMOTE_DIR = 'remote';
const NOISE_KEY_FILE = 'noise-key.json';

/** The Kokoro voice picked on the Mac, handed to a paired phone so both sound alike. */
export function kokoroVoicePath(home: string): string {
  return join(home, MEMNOX_HOME, VOICE_DIR, KOKORO_VOICE_FILE);
}

/** This machine's Noise static key, which a phone learns at pairing and checks on every connection. */
export function noiseKeyPath(home: string): string {
  return join(home, MEMNOX_HOME, REMOTE_DIR, NOISE_KEY_FILE);
}

const UPDATES_FILE = 'updates.jsonl';

/** One line per upgrade `memnox update` ran, so an unverified install stays on the record. */
export function updatesLogPath(home: string): string {
  return join(home, MEMNOX_HOME, UPDATES_FILE);
}
