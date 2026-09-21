/**
 * What a session is about to write, narrower than the file, read off git's hunk headers
 * (`@@ -6 +6,2 @@ function retryCharge(`), which carry the lines and the enclosing function.
 * Everything fails to the whole file, so it can fail to narrow a collision, never lose one.
 */

export interface LineRange {
  from: number;
  to: number;
}

export interface WrittenRegion {
  lines: LineRange[];
  symbols: string[];
}

/** Nothing known, which is a claim on the whole file. */
export const WHOLE_FILE: WrittenRegion = { lines: [], symbols: [] };

/** `@@ -old,n +new,n @@ context`, where the context is optional and often absent. */
const HUNK = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@ ?(.*)$/;

/** `+++ b/src/billing/invoice.ts`, the new-file side of one file's header. */
const NEW_FILE = /^\+\+\+ b\/(.+)$/;

/** Every file a diff covers, so the caller knows whether a region is safe, since a symbol belongs to one file. */
export function filesIn(diff: string): string[] {
  const found: string[] = [];
  for (const line of diff.split('\n')) {
    const match = NEW_FILE.exec(line);
    if (match === null) continue;
    const name = match[1];
    if (name !== undefined && name !== '/dev/null') found.push(name);
  }
  return found;
}

/** The lines and functions a unified diff touches, read off the new-file side. */
export function regionFrom(diff: string): WrittenRegion {
  const lines: LineRange[] = [];
  const symbols = new Set<string>();

  for (const line of diff.split('\n')) {
    const hunk = HUNK.exec(line);
    if (hunk === null) continue;

    const start = Number(hunk[1]);
    if (!Number.isInteger(start) || start < 1) continue;
    const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
    // A count of zero is a pure deletion, still claimed at its row so two adjacent deletions meet.
    const span = Number.isInteger(count) && count > 0 ? count : 1;
    lines.push({ from: start, to: start + span - 1 });

    const named = symbolIn(hunk[3] ?? '');
    if (named !== null) symbols.add(named);
  }

  return { lines, symbols: [...symbols] };
}

/** Words that are never the name being written. Short on purpose, since a missing word only fails to narrow. */
const NOT_A_NAME = new Set([
  'if',
  'for',
  'while',
  'switch',
  'catch',
  'return',
  'function',
  'func',
  'def',
  'class',
  'struct',
  'interface',
  'async',
  'await',
  'export',
  'default',
  'public',
  'private',
  'protected',
  'static',
  'const',
  'let',
  'var',
  'new',
  'type',
  'impl',
  'fn',
  'sub',
  'end',
]);

const CALLABLE = /([A-Za-z_$][\w$]*)\s*\(/g;
const IDENTIFIER = /[A-Za-z_$][\w$]*/g;

/**
 * The name a hunk header points at: the word before the parameters, or else the last
 * word. Null rather than a guess, because git's context can be a closing brace.
 */
export function symbolIn(context: string): string | null {
  const text = context.trim();
  if (text === '') return null;

  for (const match of text.matchAll(CALLABLE)) {
    const name = match[1];
    if (name === undefined) continue;
    if (NOT_A_NAME.has(name)) continue;
    return name;
  }

  const words = [...text.matchAll(IDENTIFIER)]
    .map((match) => match[0])
    .filter((word) => !NOT_A_NAME.has(word));
  const last = words[words.length - 1];
  return last === undefined ? null : last;
}
