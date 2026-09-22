import {
  COME_BACK,
  editDenial,
  editOf,
  type EditChange,
  type EditIntent,
  type Replacement,
} from './edit-hook';

/**
 * The writes in any coding agent's hook payload, and the refusal in that agent's words.
 *
 * Claude Code was the only editor whose file writes met a lease, so an edit Codex or
 * Cursor made on another computer was invisible to it, and theirs to it. Each of
 * the three runs a program before it writes and reads a refusal back, and each
 * spells both halves its own way: Claude Code and Codex share `PreToolUse` and
 * `hookSpecificOutput`, Codex sends its edits as one patch, and Cursor has its own
 * event names and answers with `permission` and `agent_message`.
 *
 * **Read by exact field, never by shape.** A payload this does not recognise is one
 * it says nothing about, and the write goes through. A field it cannot find narrows
 * nothing and the whole file is claimed, which is what a lease meant before any of
 * this.
 */

/** The agents whose hooks this reads, by how the payload says which one it is. */
export const EDIT_HOST = {
  /** Claude Code and Codex both send `PreToolUse` and read `hookSpecificOutput`. */
  PRE_TOOL_USE: 'pre-tool-use',
  CURSOR: 'cursor',
  /** Gemini CLI: `BeforeTool`, and a refusal is `{ decision: "deny" }`. */
  GEMINI: 'gemini',
  /**
   * Windsurf's Cascade: `pre_write_code`, and a refusal is exit code 2 with the
   * reason on stderr, which Cascade shows the model. Nothing else it reads back.
   */
  WINDSURF: 'windsurf',
} as const;

/** Gemini CLI's own file tools, by the names its hooks report them under. */
export const GEMINI_EDIT_TOOLS: readonly string[] = ['write_file', 'replace'];

/** Windsurf's events around a write, by the name each payload carries. */
export const WINDSURF_EVENT = {
  PRE_WRITE: 'pre_write_code',
  POST_WRITE: 'post_write_code',
  POST_READ: 'post_read_code',
  POST_COMMAND: 'post_run_command',
  POST_MCP: 'post_mcp_tool_use',
} as const;

export type EditHost = (typeof EDIT_HOST)[keyof typeof EDIT_HOST];

/** Codex's patch tool, whose input is one patch string that may touch several files. */
const CODEX_PATCH_TOOL = 'apply_patch';

/** The tools Cursor names for a write, as its `preToolUse` reports them. */
export const CURSOR_EDIT_TOOLS: readonly string[] = [
  'Write',
  'Edit',
  'MultiEdit',
  'StrReplace',
  'search_replace',
  'edit_file',
];

/** Cursor's own event names, which are camel case where the others are not. */
export const CURSOR_EVENT = {
  PRE_TOOL_USE: 'preToolUse',
  AFTER_FILE_EDIT: 'afterFileEdit',
  SESSION_END: 'sessionEnd',
  POST_TOOL_USE: 'postToolUse',
  STOP: 'stop',
} as const;

/**
 * What a hook payload asks of the lease register.
 *
 * `before` is a write about to happen, which can be refused. `after` is one that
 * already happened, which is Cursor's `afterFileEdit`: it cannot be refused, and it
 * is still claimed, so the lines are held against every other machine and the
 * people are told of a collision with the lines it actually changed.
 */
export type AgentEdits =
  | { moment: 'before'; host: EditHost; edits: EditIntent[] }
  | { moment: 'after'; host: EditHost; edits: EditIntent[] };

/** Every write in this payload, or null where it is not one this reads. */
export function agentEditsOf(payload: unknown): AgentEdits | null {
  if (payload === null || typeof payload !== 'object') return null;
  const hook = payload as Record<string, unknown>;
  const event = hook['hook_event_name'];

  if (event === 'PreToolUse') {
    if (hook['tool_name'] === CODEX_PATCH_TOOL) {
      const edits = patchEditsOf(hook);
      return edits === null
        ? null
        : { moment: 'before', host: EDIT_HOST.PRE_TOOL_USE, edits };
    }
    const one = editOf(payload);
    return one === null
      ? null
      : { moment: 'before', host: EDIT_HOST.PRE_TOOL_USE, edits: [one] };
  }

  if (event === CURSOR_EVENT.PRE_TOOL_USE) {
    const tool = hook['tool_name'];
    if (typeof tool !== 'string' || !CURSOR_EDIT_TOOLS.includes(tool)) return null;
    const one = cursorEdit(hook, hook['tool_input']);
    return one === null
      ? null
      : { moment: 'before', host: EDIT_HOST.CURSOR, edits: [one] };
  }

  if (event === 'BeforeTool') {
    const tool = hook['tool_name'];
    if (typeof tool !== 'string' || !GEMINI_EDIT_TOOLS.includes(tool)) return null;
    const one = geminiEdit(hook);
    return one === null
      ? null
      : { moment: 'before', host: EDIT_HOST.GEMINI, edits: [one] };
  }

  const windsurf = hook['agent_action_name'];
  if (windsurf === WINDSURF_EVENT.PRE_WRITE || windsurf === WINDSURF_EVENT.POST_WRITE) {
    const one = windsurfEdit(hook);
    if (one === null) return null;
    return {
      moment: windsurf === WINDSURF_EVENT.PRE_WRITE ? 'before' : 'after',
      host: EDIT_HOST.WINDSURF,
      edits: [one],
    };
  }

  if (event === CURSOR_EVENT.AFTER_FILE_EDIT) {
    const one = cursorEdit(hook, hook);
    return one === null
      ? null
      : { moment: 'after', host: EDIT_HOST.CURSOR, edits: [one] };
  }
  return null;
}

/** The session that ended, in whichever agent's words, or null for any other payload. */
export function endedSessionOf(payload: unknown): string | null {
  if (payload === null || typeof payload !== 'object') return null;
  const hook = payload as Record<string, unknown>;
  const event = hook['hook_event_name'];
  if (event !== 'SessionEnd' && event !== CURSOR_EVENT.SESSION_END) return null;
  const session = sessionOf(hook);
  return session === '' ? null : session;
}

/**
 * The refusal, in the words the host reads back.
 *
 * Cursor shows `user_message` to the person and hands `agent_message` to the model;
 * the other two read one reason out of `hookSpecificOutput`.
 */
export function agentDenial(host: EditHost, reason: string): string {
  if (host === EDIT_HOST.GEMINI) {
    return JSON.stringify({ decision: 'deny', reason: `${reason} ${COME_BACK}` });
  }
  if (host === EDIT_HOST.WINDSURF) return `${reason} ${COME_BACK}`;
  if (host !== EDIT_HOST.CURSOR) return editDenial(reason);
  return JSON.stringify({
    permission: 'deny',
    user_message: reason,
    agent_message: `${reason} ${COME_BACK}`,
  });
}

/** A Gemini CLI write: `write_file` with its content, or `replace` with its text. */
function geminiEdit(hook: Record<string, unknown>): EditIntent | null {
  const input = hook['tool_input'];
  if (input === null || typeof input !== 'object') return null;
  const fields = input as Record<string, unknown>;
  const session = sessionOf(hook);
  const path = fields['file_path'];
  if (session === '' || typeof path !== 'string' || path === '') return null;
  const change = cursorChange(fields);
  const cwd = cwdOf(hook);
  return {
    path,
    sessionId: session,
    ...(cwd === undefined ? {} : { cwd }),
    ...(change === null ? {} : { change }),
  };
}

/**
 * A Windsurf write, with its edits. Windsurf names no working directory, so the
 * file's own folder stands in: the repository is found from there, and the path is
 * absolute anyway.
 */
function windsurfEdit(hook: Record<string, unknown>): EditIntent | null {
  const info = hook['tool_info'];
  if (info === null || typeof info !== 'object') return null;
  const fields = info as Record<string, unknown>;
  const session = hook['trajectory_id'];
  const path = fields['file_path'];
  if (typeof session !== 'string' || session === '') return null;
  if (typeof path !== 'string' || path === '') return null;
  const replacements = replacementsIn(fields);
  const folder = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : undefined;
  return {
    path,
    sessionId: session,
    ...(folder === undefined || folder === '' ? {} : { cwd: folder }),
    ...(replacements === null ? {} : { change: { kind: 'edit', replacements } }),
  };
}

/** Cursor calls its session a conversation everywhere but the event that ends it. */
function sessionOf(hook: Record<string, unknown>): string {
  for (const key of ['session_id', 'conversation_id']) {
    const value = hook[key];
    if (typeof value === 'string' && value.trim() !== '') return value;
  }
  return '';
}

/** Where the agent is working: its own `cwd`, or the first folder Cursor has open. */
function cwdOf(hook: Record<string, unknown>): string | undefined {
  const cwd = hook['cwd'];
  if (typeof cwd === 'string' && cwd !== '') return cwd;
  const roots = hook['workspace_roots'];
  if (Array.isArray(roots) && typeof roots[0] === 'string' && roots[0] !== '')
    return roots[0];
  return undefined;
}

/** A Cursor write, from `preToolUse`'s input or from `afterFileEdit` itself. */
function cursorEdit(hook: Record<string, unknown>, input: unknown): EditIntent | null {
  if (input === null || typeof input !== 'object') return null;
  const fields = input as Record<string, unknown>;
  const session = sessionOf(hook);
  if (session === '') return null;
  let path: unknown;
  for (const key of ['file_path', 'path', 'target_file']) {
    if (typeof fields[key] === 'string' && fields[key] !== '') {
      path = fields[key];
      break;
    }
  }
  if (typeof path !== 'string') return null;

  const change = cursorChange(fields);
  const cwd = cwdOf(hook);
  return {
    path,
    sessionId: session,
    ...(cwd === undefined ? {} : { cwd }),
    ...(change === null ? {} : { change }),
  };
}

function cursorChange(fields: Record<string, unknown>): EditChange | null {
  for (const key of ['content', 'contents']) {
    const content = fields[key];
    if (typeof content === 'string') return { kind: 'write', content };
  }
  const replacements = replacementsIn(fields);
  return replacements === null ? null : { kind: 'edit', replacements };
}

function replacementsIn(fields: Record<string, unknown>): Replacement[] | null {
  const single = replacement(fields);
  if (single !== null) return [single];
  const edits = fields['edits'];
  if (!Array.isArray(edits) || edits.length === 0) return null;
  const found: Replacement[] = [];
  for (const each of edits) {
    if (each === null || typeof each !== 'object') return null;
    const read = replacement(each as Record<string, unknown>);
    if (read === null) return null;
    found.push(read);
  }
  return found;
}

function replacement(fields: Record<string, unknown>): Replacement | null {
  const from = fields['old_string'];
  const to = fields['new_string'];
  if (typeof from !== 'string' || typeof to !== 'string' || from === '') return null;
  return { from, to, all: fields['replace_all'] === true };
}

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

/** Every file a Codex patch writes, each with the change it makes to it. */
function patchEditsOf(hook: Record<string, unknown>): EditIntent[] | null {
  const session = sessionOf(hook);
  const input = hook['tool_input'];
  if (session === '' || input === null || typeof input !== 'object') return null;
  const patch = (input as Record<string, unknown>)['command'];
  if (typeof patch !== 'string') return null;
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

interface PatchedFile {
  path: string;
  change?: EditChange;
}

/**
 * The files in a Codex patch and what each hunk replaces.
 *
 * A hunk's context and removed lines are the text it replaces, and its context and
 * added lines are what replaces it, which is exactly a replacement the edit tools
 * already describe. A hunk that adds with no context has nothing to find its place
 * by, so that file is claimed whole. A deleted file is the whole file too.
 */
export function parsePatch(patch: string): PatchedFile[] {
  const files: PatchedFile[] = [];
  let current: {
    path: string;
    added: string[] | null;
    hunks: Replacement[];
    whole: boolean;
  } | null = null;
  let old: string[] = [];
  let next: string[] = [];

  const closeHunk = (): void => {
    if (current === null || current.added !== null) return;
    if (old.length > 0 || next.length > 0) {
      if (old.length === 0) current.whole = true;
      else current.hunks.push({ from: old.join('\n'), to: next.join('\n'), all: false });
    }
    old = [];
    next = [];
  };
  const closeFile = (): void => {
    closeHunk();
    if (current === null) return;
    if (current.added !== null) {
      files.push({
        path: current.path,
        change: { kind: 'write', content: `${current.added.join('\n')}\n` },
      });
    } else if (current.whole || current.hunks.length === 0) {
      files.push({ path: current.path });
    } else {
      files.push({
        path: current.path,
        change: { kind: 'edit', replacements: current.hunks },
      });
    }
    current = null;
  };

  for (const line of patch.split('\n')) {
    if (line.startsWith(PATCH.UPDATE)) {
      closeFile();
      current = {
        path: line.slice(PATCH.UPDATE.length).trim(),
        added: null,
        hunks: [],
        whole: false,
      };
    } else if (line.startsWith(PATCH.ADD)) {
      closeFile();
      current = {
        path: line.slice(PATCH.ADD.length).trim(),
        added: [],
        hunks: [],
        whole: false,
      };
    } else if (line.startsWith(PATCH.DELETE)) {
      closeFile();
      files.push({ path: line.slice(PATCH.DELETE.length).trim() });
    } else if (
      current === null ||
      line.startsWith(PATCH.MOVE) ||
      line === PATCH.END_OF_FILE
    ) {
      continue;
    } else if (line.startsWith(PATCH.HUNK)) {
      closeHunk();
    } else if (line.startsWith(PATCH.MARKER)) {
      closeFile();
    } else if (current.added !== null) {
      if (line.startsWith('+')) current.added.push(line.slice(1));
    } else if (line.startsWith('-')) {
      old.push(line.slice(1));
    } else if (line.startsWith('+')) {
      next.push(line.slice(1));
    } else if (line.startsWith(' ')) {
      old.push(line.slice(1));
      next.push(line.slice(1));
    }
  }
  closeFile();
  return files.filter((file) => file.path !== '');
}

/**
 * The file as it was before a change that has already been written.
 *
 * Cursor's `afterFileEdit` reports its edits once they are on disk, so the lines
 * they changed are found by taking them back out: each replacement undone, last
 * first. Null where the new text is not in the file, which is a file something else
 * changed since.
 */
export function beforeEdit(after: string, change: EditChange): string | null {
  if (change.kind === 'write') return null;
  let text = after;
  for (const each of [...change.replacements].reverse()) {
    if (each.to === '' || !text.includes(each.to)) return null;
    text = each.all
      ? text.split(each.to).join(each.from)
      : text.replace(each.to, () => each.from);
  }
  return text;
}
