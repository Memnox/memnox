/**
 * What blast-radius escalation guards on a first run.
 *
 * The advisor only registers when the runtime is given protected paths, so a
 * `setup` that names none builds a code graph that can never escalate anything.
 * Naming them by hand was the homework nobody did, and the guard stayed off.
 *
 * These are the directories whose breakage is expensive and quiet: a change
 * that transitively reaches one is worth a human's attention even when no rule
 * names the file being edited.
 */
const SENSITIVE_SEGMENTS: readonly string[] = [
  'auth',
  'billing',
  'credential',
  'crypto',
  'migration',
  'migrations',
  'payment',
  'payments',
  'secret',
  'secrets',
  'security',
  'session',
  'token',
];

/** A directory named `auth` protects `auth/**`, not a file called `author.ts`. */
function patternFor(segment: string): string {
  return `*${segment}/*`;
}

/**
 * Derives protected-path patterns from the files the code graph actually found.
 *
 * Only patterns with a real match are returned: a pattern that matches nothing
 * reads in `memnox status` as a guard that is on, and it is not.
 */
export function detectProtectedPaths(files: readonly string[]): string[] {
  const segments = new Set<string>();
  for (const file of files) {
    for (const part of file.toLowerCase().split('/').slice(0, -1)) {
      if (SENSITIVE_SEGMENTS.includes(part)) segments.add(part);
    }
  }
  return [...segments].sort().map(patternFor);
}
