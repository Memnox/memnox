/**
 * Reading a coding agent's hook payload by exact field, never by shape: the session, the
 * working directory, and the change an edit tool describes, one way for every hook.
 */

/** A hook payload, or any object inside one, before a field has been read out of it. */
export type HookFields = Record<string, unknown>;

/** One replacement an edit tool makes: this text, for that one. */
export interface Replacement {
  from: string;
  to: string;
  /** Every occurrence rather than the one. */
  all: boolean;
}

/**
 * What a write does to the file. Absent where
 * the tool says neither, which claims the file.
 */
export const EDIT_CHANGE = {
  /** Ordered replacements, which is what Edit and MultiEdit send. */
  EDIT: 'edit',
  /** The whole new content, which is what Write sends. */
  WRITE: 'write',
} as const;

export type EditChange =
  | { kind: typeof EDIT_CHANGE.EDIT; replacements: Replacement[] }
  | { kind: typeof EDIT_CHANGE.WRITE; content: string };

/** One write an editor is about to make, as far as a lease needs to know it. */
export interface EditIntent {
  /** The file, as the tool named it: usually absolute. */
  path: string;
  /** The editor's own session, which is what makes a second edit a renewal. */
  sessionId: string;
  /** Where the session is working, which is what a relative path is relative to. */
  cwd?: string;
  /** What it changes, so the lease can name the lines rather than the file. */
  change?: EditChange;
}

/** Codex's patch tool, whose input is one patch string that may touch several files. */
export const CODEX_PATCH_TOOL = 'apply_patch';

/** Cursor calls its session a conversation everywhere but the event that ends it. */
const SESSION_KEYS: readonly string[] = ['session_id', 'conversation_id'];

export function fieldsOf(value: unknown): HookFields | null {
  if (value === null || typeof value !== 'object') return null;
  // Every property of a parsed JSON object is `unknown` until a reader narrows it.
  return value as HookFields;
}

/** The first of these fields holding a non-empty string. */
export function firstText(
  fields: HookFields,
  keys: readonly string[],
): string | undefined {
  for (const key of keys) {
    const value = fields[key];
    if (typeof value === 'string' && value !== '') return value;
  }
  return undefined;
}

/** The agent's session, or empty where the payload names none. */
export function sessionOf(hook: HookFields): string {
  for (const key of SESSION_KEYS) {
    const value = hook[key];
    if (typeof value === 'string' && value.trim() !== '') return value;
  }
  return '';
}

/** Where the agent is working: its own `cwd`, or the first folder Cursor has open. */
export function cwdOf(hook: HookFields): string | undefined {
  const cwd = hook['cwd'];
  if (typeof cwd === 'string' && cwd !== '') return cwd;
  const roots = hook['workspace_roots'];
  if (Array.isArray(roots) && typeof roots[0] === 'string' && roots[0] !== '')
    return roots[0];
  return undefined;
}

/**
 * The folder a file is in, which stands in for a working directory Windsurf never names.
 */
export function folderOf(path: string): string | undefined {
  const folder = path.slice(0, Math.max(path.lastIndexOf('/'), 0));
  return folder === '' ? undefined : folder;
}

/**
 * The change in a tool's input: whole content under one of these keys, or replacements.
 */
export function changeIn(
  fields: HookFields,
  contentKeys: readonly string[],
): EditChange | null {
  for (const key of contentKeys) {
    const content = fields[key];
    if (typeof content === 'string') return { kind: EDIT_CHANGE.WRITE, content };
  }
  const replacements = replacementsIn(fields);
  return replacements === null ? null : { kind: EDIT_CHANGE.EDIT, replacements };
}

/**
 * One replacement, or the ordered `edits` list, or null where any of them cannot be read.
 */
export function replacementsIn(fields: HookFields): Replacement[] | null {
  const single = replacementOf(fields);
  if (single !== null) return [single];
  const edits = fields['edits'];
  if (!Array.isArray(edits) || edits.length === 0) return null;
  const found: Replacement[] = [];
  for (const each of edits) {
    const edit = fieldsOf(each);
    // One edit this cannot read makes every line
    // after it a guess, so the whole file is claimed.
    const read = edit === null ? null : replacementOf(edit);
    if (read === null) return null;
    found.push(read);
  }
  return found;
}

function replacementOf(fields: HookFields): Replacement | null {
  const from = fields['old_string'];
  const to = fields['new_string'];
  if (typeof from !== 'string' || typeof to !== 'string' || from === '') return null;
  return { from, to, all: fields['replace_all'] === true };
}
