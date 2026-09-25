/**
 * Where a `git clone` puts the repository, read from its argv the way git reads it: the
 * directory named after the URL, or else the last part of the URL without `.git`.
 */
import { isAbsolute, join } from 'node:path';

/** Clone's own flags that take a value, so the value is never read as the URL. */
const CLONE_VALUE_FLAGS = new Set([
  '-b',
  '--branch',
  '-o',
  '--origin',
  '-c',
  '--config',
  '--depth',
  '--reference',
  '--separate-git-dir',
  '-j',
  '--jobs',
  '--filter',
  '-u',
  '--upload-pack',
  '--template',
]);

export interface CloneTarget {
  url: string;
  /** Absolute, resolved against the directory the command ran in. */
  directory: string;
}

/** Null for anything that is not a clone, or a clone this cannot place. */
export function cloneTargetOf(argv: readonly string[], cwd: string): CloneTarget | null {
  const [binary, subcommand, ...rest] = argv;
  if (binary?.split('/').pop() !== 'git' || subcommand !== 'clone') return null;
  const positional: string[] = [];
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index] as string;
    if (CLONE_VALUE_FLAGS.has(arg)) {
      index += 1;
      continue;
    }
    if (!arg.startsWith('-')) positional.push(arg);
  }
  const [url, named] = positional;
  if (url === undefined) return null;
  const name =
    named ??
    url
      .replace(/\/+$/, '')
      .split(/[/:]/)
      .pop()
      ?.replace(/\.git$/, '');
  if (name === undefined || name === '') return null;
  return { url, directory: isAbsolute(name) ? name : join(cwd, name) };
}
