/**
 * What a session is about to write, narrower than the file.
 *
 * Two agents in one file are usually nowhere near each other, and until now the
 * only thing a lease could say was the path. Asking the agent to declare a
 * function works and is what the control plane accepts, but an agent that was
 * never told to declare one gets nothing, which is every agent nobody has
 * updated.
 *
 * So it is read off the change itself, at the moment of the write. Git already
 * computes both halves and puts them in the hunk header:
 *
 *     @@ -6 +6,2 @@ export function retryCharge(attempt: number): boolean {
 *            ↑ the lines            ↑ the enclosing function
 *
 * No parser, no syntax tree, no dependency. Git derives the context from
 * built-in patterns for most languages and says nothing for the rest, and
 * saying nothing is the safe answer here.
 *
 * **Everything about this fails to the whole file.** A new file has no diff, a
 * language git has no pattern for has no context, a repository that is not a
 * git repository has neither, and a diff that takes too long is abandoned. Each
 * of those returns nothing, and nothing already means the whole file to every
 * lease that has ever been taken. It cannot lose a collision; it can only fail
 * to narrow one.
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

/** `@@ -old,n +new,n @@ context` — the context is optional and often absent. */
const HUNK = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@ ?(.*)$/;

/** `+++ b/src/billing/invoice.ts`, the new-file side of one file's header. */
const NEW_FILE = /^\+\+\+ b\/(.+)$/;

/**
 * Every file a diff covers.
 *
 * The caller needs this to know whether a region is safe to use at all. A
 * symbol is a fact about one file, so a diff spanning several cannot be
 * reduced to one set of names: `process` from one file and `handle` from
 * another would read as a session writing two functions, and two sessions each
 * naming the functions in their *own* file would look like they had nothing in
 * common when in truth nothing had been compared.
 */
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

/**
 * The lines and functions a unified diff touches.
 *
 * Reads the new-file side, because that is where the session is writing. A hunk
 * that only deletes claims the line it deleted at, so two agents removing
 * adjacent code still meet.
 */
export function regionFrom(diff: string): WrittenRegion {
  const lines: LineRange[] = [];
  const symbols = new Set<string>();

  for (const line of diff.split('\n')) {
    const hunk = HUNK.exec(line);
    if (hunk === null) continue;

    const start = Number(hunk[1]);
    if (!Number.isInteger(start) || start < 1) continue;
    const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
    /* A count of zero is a pure deletion: the new file has no lines here, and
       the change is still at this row. Claiming it keeps two sessions deleting
       next to each other from passing each other. */
    const span = Number.isInteger(count) && count > 0 ? count : 1;
    lines.push({ from: start, to: start + span - 1 });

    const named = symbolIn(hunk[3] ?? '');
    if (named !== null) symbols.add(named);
  }

  return { lines, symbols: [...symbols] };
}

/**
 * Words that are never the name of the thing being written.
 *
 * Short on purpose. A word missing from here can only produce a symbol that
 * matches nothing, which narrows a claim less than it could have; a real name
 * wrongly listed here would drop a symbol that was correct.
 */
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
 * The name of the thing a hunk header points at.
 *
 * A declaration is a name immediately before its parameters, which covers
 * `function retryCharge(`, `def retry_charge(`, `  async retryCharge(` and
 * Go's `func (s *Svc) RetryCharge(`, where the receiver is skipped because
 * `func` is a word this never takes. Anything with no parameters at all is a
 * class or a type, and the last word of it is its name.
 *
 * Null rather than a guess where neither shape is there. Git's context can be a
 * closing brace or a blank, and inventing a symbol from one would put a name on
 * a claim that nothing in the file is called.
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
