import { readFile, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { interceptorDirFor } from '@memnox/interceptors';

/**
 * The one seam that cannot be carried by `memnox run`: an editor somebody opened from
 * a dock icon takes its environment from the login shell, not from a process we start.
 *
 * So this writes the line, and only when asked for by name. It is fenced by markers,
 * it is the last thing appended, and `--revert` takes out exactly what is between the
 * markers and nothing else. A tool that silently rewrote a `.zshrc` is one nobody
 * trusts twice; a tool that cannot put its own line back is the same problem later.
 */
const BEGIN = '# >>> memnox >>>';
const END = '# <<< memnox <<<';

/** The profile each shell actually reads for an interactive login session. */
const PROFILES: Readonly<Record<string, readonly string[]>> = {
  zsh: ['.zshrc'],
  bash: ['.bashrc', '.bash_profile'],
  fish: ['.config/fish/config.fish'],
};

interface ProfileEdit {
  path: string;
  /** What the file says about us after the edit: present, absent, or already right. */
  state: 'added' | 'removed' | 'unchanged';
}

/** The profiles for the shell in use, newest-first, so the first that exists wins. */
export function profilesFor(shell: string, home: string): string[] {
  const name = basename(shell || 'zsh');
  const known = Object.entries(PROFILES).find(([key]) => name.includes(key));
  const relative = known === undefined ? PROFILES['zsh'] : known[1];
  return (relative as readonly string[]).map((each) => join(home, each));
}

/** fish sets PATH differently, and a bash line pasted into it silently does nothing. */
export function pathLineFor(shell: string, home: string): string {
  const directory = interceptorDirFor(home);
  return basename(shell || 'zsh').includes('fish')
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
  if (hasBlock(existing)) return { path, state: 'unchanged' };
  const separator = existing === '' || existing.endsWith('\n') ? '' : '\n';
  await writeFile(path, `${existing}${separator}\n${block}`, 'utf8');
  return { path, state: 'added' };
}

export async function removeFromProfile(path: string): Promise<ProfileEdit> {
  const existing = await read(path);
  if (!hasBlock(existing)) return { path, state: 'unchanged' };
  await writeFile(path, withoutBlock(existing), 'utf8');
  return { path, state: 'removed' };
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
