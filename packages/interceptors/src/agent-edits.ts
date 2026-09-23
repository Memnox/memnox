import { patchEditsOf } from './codex-patch';
import { COME_BACK, EDIT_HOOK_EVENT, editDenial, editOf } from './edit-hook';
import {
  changeIn,
  CODEX_PATCH_TOOL,
  cwdOf,
  EDIT_CHANGE,
  fieldsOf,
  firstText,
  folderOf,
  replacementsIn,
  sessionOf,
  type EditChange,
  type EditIntent,
  type HookFields,
} from './hook-payload';

/**
 * The writes in any coding agent's hook payload, and the refusal in that agent's words.
 * Read by exact field, never by shape: an unrecognised payload goes through, and a field
 * that cannot be found claims the whole file.
 */

/** The agents whose hooks this reads, by how the payload says which one it is. */
export const EDIT_HOST = {
  /** Claude Code and Codex both send `PreToolUse` and read `hookSpecificOutput`. */
  PRE_TOOL_USE: 'pre-tool-use',
  CURSOR: 'cursor',
  /** Gemini CLI: `BeforeTool`, and a refusal is `{ decision: "deny" }`. */
  GEMINI: 'gemini',
  /**
   * Windsurf's Cascade: `pre_write_code`, refused
   * by exit code 2 with the reason on stderr.
   */
  WINDSURF: 'windsurf',
} as const;

export type EditHost = (typeof EDIT_HOST)[keyof typeof EDIT_HOST];

/** Gemini CLI's own file tools, by the names its hooks report them under. */
export const GEMINI_EDIT_TOOLS: readonly string[] = ['write_file', 'replace'];

/** Gemini CLI's events, which name the turn after the agent rather than a stop. */
export const GEMINI_EVENT = {
  BEFORE_TOOL: 'BeforeTool',
  AFTER_TOOL: 'AfterTool',
  BEFORE_AGENT: 'BeforeAgent',
  AFTER_AGENT: 'AfterAgent',
} as const;

/** Windsurf's events around a write, by the name each payload carries. */
export const WINDSURF_EVENT = {
  PRE_WRITE: 'pre_write_code',
  POST_WRITE: 'post_write_code',
  POST_READ: 'post_read_code',
  POST_COMMAND: 'post_run_command',
  POST_MCP: 'post_mcp_tool_use',
  /** Before a read, a command or an MCP call, where a rule can still refuse it. */
  PRE_READ: 'pre_read_code',
  PRE_COMMAND: 'pre_run_command',
  PRE_MCP: 'pre_mcp_tool_use',
} as const;

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
  /** Before a command, an MCP call or a read, where a rule can still refuse it. */
  BEFORE_SHELL: 'beforeShellExecution',
  BEFORE_MCP: 'beforeMCPExecution',
  BEFORE_READ: 'beforeReadFile',
} as const;

/**
 * `before` is a write that can be refused; `after` is
 * already on disk and is claimed to report a collision.
 */
export const EDIT_MOMENT = { BEFORE: 'before', AFTER: 'after' } as const;

export type EditMoment = (typeof EDIT_MOMENT)[keyof typeof EDIT_MOMENT];

/** What a hook payload asks of the lease register. */
export interface AgentEdits {
  moment: EditMoment;
  host: EditHost;
  edits: EditIntent[];
}

/** Where Cursor and Gemini put a whole new file's content. */
const CONTENT_KEYS: readonly string[] = ['content', 'contents'];

/** Where Cursor names the file a write goes to. */
const CURSOR_PATH_KEYS: readonly string[] = ['file_path', 'path', 'target_file'];

/** Every write in this payload, or null where it is not one this reads. */
export function agentEditsOf(payload: unknown): AgentEdits | null {
  const hook = fieldsOf(payload);
  if (hook === null) return null;
  const event = hook['hook_event_name'];

  if (event === EDIT_HOOK_EVENT.PRE_TOOL_USE) {
    return editsAt(EDIT_MOMENT.BEFORE, EDIT_HOST.PRE_TOOL_USE, preToolUseEdits(hook));
  }
  if (event === CURSOR_EVENT.PRE_TOOL_USE) {
    const edit = usesTool(hook, CURSOR_EDIT_TOOLS)
      ? cursorEdit(hook, hook['tool_input'])
      : null;
    return editsAt(EDIT_MOMENT.BEFORE, EDIT_HOST.CURSOR, listOf(edit));
  }
  if (event === GEMINI_EVENT.BEFORE_TOOL) {
    const edit = usesTool(hook, GEMINI_EDIT_TOOLS) ? geminiEdit(hook) : null;
    return editsAt(EDIT_MOMENT.BEFORE, EDIT_HOST.GEMINI, listOf(edit));
  }
  const windsurf = hook['agent_action_name'];
  if (windsurf === WINDSURF_EVENT.PRE_WRITE || windsurf === WINDSURF_EVENT.POST_WRITE) {
    const moment =
      windsurf === WINDSURF_EVENT.PRE_WRITE ? EDIT_MOMENT.BEFORE : EDIT_MOMENT.AFTER;
    return editsAt(moment, EDIT_HOST.WINDSURF, listOf(windsurfEdit(hook)));
  }
  if (event === CURSOR_EVENT.AFTER_FILE_EDIT) {
    return editsAt(EDIT_MOMENT.AFTER, EDIT_HOST.CURSOR, listOf(cursorEdit(hook, hook)));
  }
  return null;
}

function editsAt(
  moment: EditMoment,
  host: EditHost,
  edits: EditIntent[] | null,
): AgentEdits | null {
  return edits === null ? null : { moment, host, edits };
}

function listOf(edit: EditIntent | null): EditIntent[] | null {
  return edit === null ? null : [edit];
}

function usesTool(hook: HookFields, tools: readonly string[]): boolean {
  const tool = hook['tool_name'];
  return typeof tool === 'string' && tools.includes(tool);
}

/**
 * Claude Code's write, or every file in Codex's patch, since both arrive as `PreToolUse`.
 */
function preToolUseEdits(hook: HookFields): EditIntent[] | null {
  if (hook['tool_name'] === CODEX_PATCH_TOOL) return patchEditsOf(hook);
  return listOf(editOf(hook));
}

/** The session that ended, in whichever agent's words, or null for any other payload. */
export function endedSessionOf(payload: unknown): string | null {
  const hook = fieldsOf(payload);
  if (hook === null) return null;
  const event = hook['hook_event_name'];
  if (event !== EDIT_HOOK_EVENT.SESSION_END && event !== CURSOR_EVENT.SESSION_END)
    return null;
  const session = sessionOf(hook);
  return session === '' ? null : session;
}

/**
 * The refusal, in the words the host reads back:
 * Cursor splits the person's line from the model's.
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

function intentOf(
  path: string,
  sessionId: string,
  cwd: string | undefined,
  change: EditChange | null,
): EditIntent {
  return {
    path,
    sessionId,
    ...(cwd === undefined ? {} : { cwd }),
    ...(change === null ? {} : { change }),
  };
}

/** A Gemini CLI write: `write_file` with its content, or `replace` with its text. */
function geminiEdit(hook: HookFields): EditIntent | null {
  const fields = fieldsOf(hook['tool_input']);
  if (fields === null) return null;
  const session = sessionOf(hook);
  const path = firstText(fields, ['file_path']);
  if (session === '' || path === undefined) return null;
  return intentOf(path, session, cwdOf(hook), changeIn(fields, CONTENT_KEYS));
}

/**
 * A Windsurf write. Windsurf names no working
 * directory, so the file's own folder stands in.
 */
function windsurfEdit(hook: HookFields): EditIntent | null {
  const fields = fieldsOf(hook['tool_info']);
  if (fields === null) return null;
  const session = firstText(hook, ['trajectory_id']);
  const path = firstText(fields, ['file_path']);
  if (session === undefined || path === undefined) return null;
  const replacements = replacementsIn(fields);
  const change: EditChange | null =
    replacements === null ? null : { kind: EDIT_CHANGE.EDIT, replacements };
  return intentOf(path, session, folderOf(path), change);
}

/** A Cursor write, from `preToolUse`'s input or from `afterFileEdit` itself. */
function cursorEdit(hook: HookFields, input: unknown): EditIntent | null {
  const fields = fieldsOf(input);
  if (fields === null) return null;
  const session = sessionOf(hook);
  const path = firstText(fields, CURSOR_PATH_KEYS);
  if (session === '' || path === undefined) return null;
  return intentOf(path, session, cwdOf(hook), changeIn(fields, CONTENT_KEYS));
}

/**
 * The file as it was before a change already written, found by undoing each replacement
 * last first, because Cursor reports its edits once they are on disk. Null where the new
 * text is not in the file, which means something else changed it.
 */
export function beforeEdit(after: string, change: EditChange): string | null {
  if (change.kind === EDIT_CHANGE.WRITE) return null;
  let text = after;
  for (const each of [...change.replacements].reverse()) {
    if (each.to === '' || !text.includes(each.to)) return null;
    text = each.all
      ? text.split(each.to).join(each.from)
      : text.replace(each.to, () => each.from);
  }
  return text;
}
