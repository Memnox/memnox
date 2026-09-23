import {
  cwdOf,
  EDIT_CHANGE,
  fieldsOf,
  sessionOf,
  type EditChange,
  type EditIntent,
  type HookFields,
  type Replacement,
} from './hook-payload';

/**
 * Codex's `apply_patch` input read as the files it
 * writes and the replacements it makes to each.
 */

/** Codex's patch markers, as its `apply_patch` tool writes them. */
const PATCH = {
  UPDATE: '*** Update File: ',
  ADD: '*** Add File: ',
  DELETE: '*** Delete File: ',
  MOVE: '*** Move to: ',
  END_OF_FILE: '*** End of File',
  HUNK: '@@',
  MARKER: '***',
} as const;

export interface PatchedFile {
  path: string;
  change?: EditChange;
}

/** Which of a patch's line kinds this is, so the parser reads as a table. */
const PATCH_LINE = {
  /** Opens a file whose existing content is being edited hunk by hunk. */
  UPDATE: 'update',
  /** Opens a file being created whole. */
  ADD: 'add',
  /** A file being removed, which claims the whole of it. */
  DELETE: 'delete',
  /** Ends the hunk in progress and starts another in the same file. */
  HUNK: 'hunk',
  /** Any other `***` line, which ends the file in progress. */
  MARKER: 'marker',
  /** A line the patch keeps: context on both sides of the change. */
  CONTEXT: 'context',
  /** A line the patch removes. */
  REMOVED: 'removed',
  /** A line the patch adds. */
  ADDED: 'added',
  /** Carries no content: a move directive, an end-of-file marker, or noise. */
  IGNORED: 'ignored',
} as const;

type PatchLine = (typeof PATCH_LINE)[keyof typeof PATCH_LINE];

/** What one line of a Codex patch is, and the text it carries. */
function classifyPatchLine(line: string): { kind: PatchLine; text: string } {
  if (line.startsWith(PATCH.UPDATE)) {
    return { kind: PATCH_LINE.UPDATE, text: line.slice(PATCH.UPDATE.length).trim() };
  }
  if (line.startsWith(PATCH.ADD)) {
    return { kind: PATCH_LINE.ADD, text: line.slice(PATCH.ADD.length).trim() };
  }
  if (line.startsWith(PATCH.DELETE)) {
    return { kind: PATCH_LINE.DELETE, text: line.slice(PATCH.DELETE.length).trim() };
  }
  if (line.startsWith(PATCH.MOVE) || line === PATCH.END_OF_FILE) {
    return { kind: PATCH_LINE.IGNORED, text: '' };
  }
  if (line.startsWith(PATCH.HUNK)) return { kind: PATCH_LINE.HUNK, text: '' };
  if (line.startsWith(PATCH.MARKER)) return { kind: PATCH_LINE.MARKER, text: '' };
  if (line.startsWith('-')) return { kind: PATCH_LINE.REMOVED, text: line.slice(1) };
  if (line.startsWith('+')) return { kind: PATCH_LINE.ADDED, text: line.slice(1) };
  if (line.startsWith(' ')) return { kind: PATCH_LINE.CONTEXT, text: line.slice(1) };
  return { kind: PATCH_LINE.IGNORED, text: '' };
}

/**
 * The file a patch is describing and the hunk inside it, with a method per transition.
 */
class PatchReader {
  private readonly files: PatchedFile[] = [];
  private path: string | null = null;
  /** Non-null while a file is being created whole, holding the lines added so far. */
  private created: string[] | null = null;
  private hunks: Replacement[] = [];
  /** True once something in this file could not be placed, which claims all of it. */
  private whole = false;
  private removed: string[] = [];
  private added: string[] = [];

  /** Every file the patch touched, skipping any the patch named with an empty path. */
  done(): PatchedFile[] {
    this.endFile();
    return this.files.filter((file) => file.path !== '');
  }

  read(line: string): void {
    const { kind, text } = classifyPatchLine(line);
    switch (kind) {
      case PATCH_LINE.UPDATE:
        return this.startFile(text, null);
      case PATCH_LINE.ADD:
        return this.startFile(text, []);
      case PATCH_LINE.DELETE:
        this.endFile();
        // A deleted file has no hunks to narrow by, so the whole of it is claimed.
        this.files.push({ path: text });
        return;
      case PATCH_LINE.HUNK:
        return this.endHunk();
      case PATCH_LINE.MARKER:
        return this.endFile();
      default:
        return this.readContent(kind, text);
    }
  }

  /** A line of the change itself, which only means anything inside a file. */
  private readContent(kind: PatchLine, text: string): void {
    if (this.path === null) return;
    if (this.created !== null) {
      if (kind === PATCH_LINE.ADDED) this.created.push(text);
      return;
    }
    if (kind === PATCH_LINE.REMOVED) this.removed.push(text);
    else if (kind === PATCH_LINE.ADDED) this.added.push(text);
    else if (kind === PATCH_LINE.CONTEXT) {
      this.removed.push(text);
      this.added.push(text);
    }
  }

  private startFile(path: string, created: string[] | null): void {
    this.endFile();
    this.path = path;
    this.created = created;
    this.hunks = [];
    this.whole = false;
  }

  /**
   * The hunk in progress as a replacement; one removing
   * nothing cannot be placed, so claims the file.
   */
  private endHunk(): void {
    if (this.path === null || this.created !== null) return;
    if (this.removed.length > 0 || this.added.length > 0) {
      if (this.removed.length === 0) this.whole = true;
      else {
        this.hunks.push({
          from: this.removed.join('\n'),
          to: this.added.join('\n'),
          all: false,
        });
      }
    }
    this.removed = [];
    this.added = [];
  }

  private endFile(): void {
    this.endHunk();
    if (this.path === null) return;
    this.files.push(this.fileSoFar(this.path));
    this.path = null;
  }

  /** A created file is a whole write; an edited one is its hunks, or the whole file. */
  private fileSoFar(path: string): PatchedFile {
    if (this.created !== null) {
      return {
        path,
        change: { kind: EDIT_CHANGE.WRITE, content: `${this.created.join('\n')}\n` },
      };
    }
    if (this.whole || this.hunks.length === 0) return { path };
    return { path, change: { kind: EDIT_CHANGE.EDIT, replacements: this.hunks } };
  }
}

/**
 * The files in a Codex patch, each with what its
 * hunks replace; a deleted file is claimed whole.
 */
export function parsePatch(patch: string): PatchedFile[] {
  const reader = new PatchReader();
  for (const line of patch.split('\n')) reader.read(line);
  return reader.done();
}

/**
 * Every file a Codex patch in this payload writes, each with the change it makes to it.
 */
export function patchEditsOf(hook: HookFields): EditIntent[] | null {
  const session = sessionOf(hook);
  const patch = fieldsOf(hook['tool_input'])?.['command'];
  if (session === '' || typeof patch !== 'string') return null;
  const cwd = cwdOf(hook);
  const files = parsePatch(patch);
  if (files.length === 0) return null;
  return files.map((file) => ({
    path: file.path,
    sessionId: session,
    ...(cwd === undefined ? {} : { cwd }),
    ...(file.change === undefined ? {} : { change: file.change }),
  }));
}
