/**
 * Whether the repository a run starts in is one this person has worked in before: one
 * the seams have already seen, one whose origin matches such a repository, or one they
 * have commits in. A repository that is none of those earns a hint toward `--untrusted`.
 */
import { execFileSync } from 'node:child_process';

import { ownProcessEnv, watchedRepositories } from '@memnox/core';

/** What is known about the repository a run starts in. */
export interface Familiarity {
  root: string;
  origin: string | null;
  /** Repositories the seams have seen on this machine, with their origins. */
  remembered: readonly { root: string; origin: string | null }[];
  /** Whether the person's git identity has a commit here. */
  authored: boolean;
}

/** True when anything says this person has worked here; a fresh clone of a stranger's is not. */
export function isFamiliar(known: Familiarity): boolean {
  if (known.authored) return true;
  if (known.remembered.some((each) => each.root === known.root)) return true;
  const origin = known.origin === null ? null : normalizedOrigin(known.origin);
  if (origin === null) return false;
  return known.remembered.some(
    (each) => each.origin !== null && normalizedOrigin(each.origin) === origin,
  );
}

/** `git@github.com:a/b.git` and `https://github.com/a/b` are one repository. */
export function normalizedOrigin(url: string): string {
  return url
    .trim()
    .toLowerCase()
    .replace(/^[a-z+]+:\/\//, '')
    .replace(/^[^@/]+@/, '')
    .replace(':', '/')
    .replace(/\.git$/, '')
    .replace(/\/$/, '');
}

/** The one line a run prints, or null where the repository is familiar. */
export function untrustedHint(known: Familiarity | null): string | null {
  if (known === null || isFamiliar(known)) return null;
  const where = known.origin ?? known.root;
  return `${where} is new to you here. "memnox run --untrusted -- <agent>" walls it off.`;
}

/** What git says about `root`, read before any seam in this run remembers it. */
export function familiarityOf(home: string, root: string): Familiarity {
  return {
    root,
    origin: gitRead(root, ['config', '--get', 'remote.origin.url']),
    remembered: watchedRepositories(home).map((each) => ({
      root: each,
      origin: gitRead(each, ['config', '--get', 'remote.origin.url']),
    })),
    authored: authoredIn(root),
  };
}

function authoredIn(root: string): boolean {
  const email = gitRead(root, ['config', '--get', 'user.email']);
  if (email === null) return false;
  return gitRead(root, ['log', '-1', '--format=%H', `--author=${email}`]) !== null;
}

/** Trimmed output, or null for an error or nothing printed. */
function gitRead(cwd: string, args: readonly string[]): string | null {
  try {
    const out = execFileSync('git', [...args], {
      cwd,
      // The real git: the one on PATH may be the interceptor, which would rule on this.
      env: ownProcessEnv(),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return out === '' ? null : out;
  } catch {
    // Not a repository, no remote, or no git: each is simply not known.
    return null;
  }
}
