import { readFile, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { interceptorDirFor } from '@memnox/interceptors';

/**
 * The login PATH line, for an editor opened from a dock icon that `memnox run` never
 * starts. Written only when asked, fenced by markers that `--revert` takes out whole.
 */

const BEGIN = '# >>> memnox >>>';
const END = '# <<< memnox <<<';

/** What a shell is assumed to be when the environment names none. */
export const DEFAULT_SHELL = 'zsh';

/** The profile each shell actually reads for an interactive login session. */
const PROFILES: Readonly<Record<string, readonly string[]>> = {
  zsh: ['.zshrc'],
  bash: ['.bashrc', '.bash_profile'],
  fish: ['.config/fish/config.fish'],
};

/** What the file says about our line after an edit: present, absent, or already right. */
export const PROFILE_STATE = {
  ADDED: 'added',
  REMOVED: 'removed',
  UNCHANGED: 'unchanged',
} as const;

type ProfileState = (typeof PROFILE_STATE)[keyof typeof PROFILE_STATE];

interface ProfileEdit {
  path: string;
  state: ProfileState;
}

/** The profiles for the shell in use, newest-first, so the first that exists wins. */
export function profilesFor(shell: string, home: string): string[] {
  const name = basename(shell || DEFAULT_SHELL);
  const known = Object.entries(PROFILES).find(([key]) => name.includes(key));
  const relative = known === undefined ? PROFILES[DEFAULT_SHELL] : known[1];
  // DEFAULT_SHELL is a key of PROFILES, so the fallback is always there.
  return (relative as readonly string[]).map((each) => join(home, each));
}

/** fish sets PATH differently, and a bash line pasted into it silently does nothing. */
export function pathLineFor(shell: string, home: string): string {
  const directory = interceptorDirFor(home);
  return basename(shell || DEFAULT_SHELL).includes('fish')
    ? `fish_add_path --prepend --move ${directory}`
    : `export PATH="${directory}:$PATH"`;
}

export function blockFor(shell: string, home: string): string {
  return [
    BEGIN,
    '# Added by "memnox protect --path". Remove with "memnox protect --revert-path".',
    pathLineFor(shell, home),
    END,
    '',
  ].join('\n');
}

/** Everything outside the markers is theirs and is copied through untouched. */
function withoutBlock(contents: string): string {
  const from = contents.indexOf(BEGIN);
  if (from === -1) return contents;
  const to = contents.indexOf(END, from);
  if (to === -1) return contents;
  const after = contents.slice(to + END.length).replace(/^\n/, '');
  return `${contents.slice(0, from).replace(/\n+$/, '\n')}${after}`;
}

function hasBlock(contents: string): boolean {
  return contents.includes(BEGIN);
}

export async function addToProfile(path: string, block: string): Promise<ProfileEdit> {
  const existing = await read(path);
  if (hasBlock(existing)) return { path, state: PROFILE_STATE.UNCHANGED };
  const separator = existing === '' || existing.endsWith('\n') ? '' : '\n';
  await writeFile(path, `${existing}${separator}\n${block}`, 'utf8');
  return { path, state: PROFILE_STATE.ADDED };
}

export async function removeFromProfile(path: string): Promise<ProfileEdit> {
  const existing = await read(path);
  if (!hasBlock(existing)) return { path, state: PROFILE_STATE.UNCHANGED };
  await writeFile(path, withoutBlock(existing), 'utf8');
  return { path, state: PROFILE_STATE.REMOVED };
}

async function read(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    // No profile yet is the ordinary case on a fresh machine, not a failure.
    return '';
  }
}

/** True when our line is in a profile the login shell actually reads. */
export async function loginPathConfigured(shell: string, home: string): Promise<boolean> {
  for (const path of profilesFor(shell, home)) {
    if (hasBlock(await read(path))) return true;
  }
  return false;
}
