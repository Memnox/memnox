import { randomUUID } from 'node:crypto';
import { relative, isAbsolute } from 'node:path';
import {
  ACTOR_TYPE,
  DECISION_EFFECT,
  digest,
  ENFORCEMENT_MODE,
  EVENT_SCHEMA_VERSION,
  EVENT_SURFACE,
  TOOL_CLASS,
  type MemnoxEvent,
} from '@memnox/core';
import { EDIT_HOST, parsePatch, type EditHost } from './agent-edits';

/**
 * The two pauses every coding agent already has, as this hook reads them: a tool
 * call just returned, and a turn just ended.
 *
 * Both are where a note waiting for the session is handed over, which is how a
 * person steers a running agent and how the agent that got there first hears that
 * another collided with it. The first is also where what the agent just did is
 * written down, so the workspace sees each session as it works rather than a
 * minute later in a batch.
 *
 * Claude Code and Codex name these `PostToolUse` and `Stop` and read
 * `hookSpecificOutput`; Cursor names them `postToolUse` and `stop` and reads its
 * own fields. Anything else is not this module's.
 */

export const SESSION_MOMENT = {
  /** A tool call returned: record it, and hand over any note as added context. */
  AFTER_TOOL: 'after-tool',
  /** The turn ended: hand over a person's note as the next thing to work on. */
  TURN_END: 'turn-end',
  /** The person just asked for something: hand over any note beside their words. */
  PROMPT: 'prompt',
} as const;

export type SessionMoment = (typeof SESSION_MOMENT)[keyof typeof SESSION_MOMENT];

export interface SessionEvent {
  moment: SessionMoment;
  host: EditHost;
  sessionId: string;
  cwd?: string;
  /** The tool that just ran, on an `after-tool` event. */
  tool?: string;
  input?: Record<string, unknown>;
}

/** The pause in this payload, or null where it is not one of the two. */
export function sessionEventOf(payload: unknown): SessionEvent | null {
  if (payload === null || typeof payload !== 'object') return null;
  const hook = payload as Record<string, unknown>;
  const event = hook['hook_event_name'];
  const windsurf = windsurfPause(hook);
  if (windsurf !== undefined) return windsurf;
  const host =
    event === 'PostToolUse' || event === 'Stop' || event === 'UserPromptSubmit'
      ? EDIT_HOST.PRE_TOOL_USE
      : event === 'postToolUse' || event === 'stop'
        ? EDIT_HOST.CURSOR
        : event === 'AfterTool' || event === 'AfterAgent' || event === 'BeforeAgent'
          ? EDIT_HOST.GEMINI
          : null;
  if (host === null) return null;

  let sessionId = '';
  for (const key of ['session_id', 'conversation_id']) {
    const value = hook[key];
    if (typeof value === 'string' && value.trim() !== '') {
      sessionId = value;
      break;
    }
  }
  if (sessionId === '') return null;

  const cwd = cwdOf(hook);
  if (event === 'UserPromptSubmit' || event === 'BeforeAgent') {
    return {
      moment: SESSION_MOMENT.PROMPT,
      host,
      sessionId,
      ...(cwd === undefined ? {} : { cwd }),
    };
  }
  if (event === 'Stop' || event === 'stop' || event === 'AfterAgent') {
    return {
      moment: SESSION_MOMENT.TURN_END,
      host,
      sessionId,
      ...(cwd === undefined ? {} : { cwd }),
    };
  }
  const tool = hook['tool_name'];
  const input = hook['tool_input'];
  return {
    moment: SESSION_MOMENT.AFTER_TOOL,
    host,
    sessionId,
    ...(cwd === undefined ? {} : { cwd }),
    ...(typeof tool === 'string' ? { tool } : {}),
    ...(input !== null && typeof input === 'object'
      ? { input: input as Record<string, unknown> }
      : {}),
  };
}

/** Windsurf's events after a read, a write, a command or an MCP call. */
const WINDSURF_AFTER: Readonly<Record<string, string>> = {
  post_write_code: 'Write',
  post_read_code: 'Read',
  post_run_command: 'Bash',
  post_mcp_tool_use: 'mcp',
};

/**
 * A Windsurf pause, or undefined where this is not a Windsurf payload at all.
 *
 * Only the moment after a tool: Windsurf has no event that ends a turn in a way
 * that can carry words back, and none that ends a session, so its holds lapse on
 * the idle window and its notes reach it through the MCP proxy.
 */
function windsurfPause(hook: Record<string, unknown>): SessionEvent | null | undefined {
  const action = hook['agent_action_name'];
  if (typeof action !== 'string') return undefined;
  const tool = WINDSURF_AFTER[action];
  if (tool === undefined) return null;
  const session = hook['trajectory_id'];
  if (typeof session !== 'string' || session === '') return null;
  const info = hook['tool_info'];
  const input =
    info !== null && typeof info === 'object' ? (info as Record<string, unknown>) : {};
  const path = input['file_path'];
  return {
    moment: SESSION_MOMENT.AFTER_TOOL,
    host: EDIT_HOST.WINDSURF,
    sessionId: session,
    tool,
    input,
    ...(typeof path === 'string' && path.includes('/')
      ? { cwd: path.slice(0, path.lastIndexOf('/')) }
      : {}),
  };
}

function cwdOf(hook: Record<string, unknown>): string | undefined {
  const cwd = hook['cwd'];
  if (typeof cwd === 'string' && cwd !== '') return cwd;
  const roots = hook['workspace_roots'];
  if (Array.isArray(roots) && typeof roots[0] === 'string' && roots[0] !== '') {
    return roots[0];
  }
  return undefined;
}

/**
 * What the host reads back: the notes, in the field that puts them in front of the
 * model at this pause. `null` notes is the ordinary case, and says nothing.
 *
 * After a tool call the notes ride as added context beside the result. At the end
 * of a turn they become the next thing the agent works on, which is how a note
 * reaches an agent that has stopped to wait: Claude Code and Codex continue with the
 * reason as their prompt, and Cursor submits the follow-up as the next message.
 * Cursor is answered with an empty object when there is nothing, because it reads a
 * reply that is not JSON as one that blocks.
 */
export function sessionAnswer(event: SessionEvent, notes: string | null): string {
  /* Windsurf reads nothing back from these, so there is nothing to say. */
  if (event.host === EDIT_HOST.WINDSURF) return '';
  if (event.host === EDIT_HOST.GEMINI) {
    if (notes === null) return '';
    if (event.moment === SESSION_MOMENT.TURN_END) {
      return JSON.stringify({ decision: 'deny', reason: notes });
    }
    return JSON.stringify({
      hookSpecificOutput: {
        hookEventName:
          event.moment === SESSION_MOMENT.PROMPT ? 'BeforeAgent' : 'AfterTool',
        additionalContext: notes,
      },
    });
  }
  if (event.host === EDIT_HOST.CURSOR) {
    if (notes === null) return '{}';
    return JSON.stringify(
      event.moment === SESSION_MOMENT.TURN_END
        ? { followup_message: notes }
        : { additional_context: notes },
    );
  }
  if (notes === null) return '';
  if (event.moment === SESSION_MOMENT.TURN_END) {
    return JSON.stringify({ decision: 'block', reason: notes });
  }
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName:
        event.moment === SESSION_MOMENT.PROMPT ? 'UserPromptSubmit' : 'PostToolUse',
      additionalContext: notes,
    },
  });
}

/** The tools that read a file, by the names the agents give them. */
const READ_TOOLS: readonly string[] = ['Read', 'NotebookRead', 'read_file'];
/* `write_file` and `replace` are Gemini CLI's, and read the same as the rest. */
/** The tools that write one. Codex's patch is read apart, since it names several. */
const WRITE_TOOLS: readonly string[] = [
  'Write',
  'Edit',
  'MultiEdit',
  'NotebookEdit',
  'StrReplace',
  'search_replace',
  'edit_file',
  'write_file',
  'replace',
];
const CODEX_PATCH_TOOL = 'apply_patch';

/**
 * What the agent just did, as rows for the ledger. Names and paths only.
 *
 * Only the tools that work inside the agent, which nothing else here sees: a shell
 * command is already a row from the interceptor that ran it, and an MCP call from
 * the proxy it went through, so recording those again would count each twice.
 */
export function activityOf(
  event: SessionEvent,
  agent: string,
  root: string | undefined,
  at: string,
): MemnoxEvent[] {
  if (event.moment !== SESSION_MOMENT.AFTER_TOOL || event.tool === undefined) return [];
  const input = event.input ?? {};
  if (event.tool === CODEX_PATCH_TOOL) {
    const patch = input['command'];
    if (typeof patch !== 'string') return [];
    return parsePatch(patch).map((file) =>
      row(
        event,
        agent,
        at,
        'file.edit',
        TOOL_CLASS.WRITE,
        shown(file.path, root, event.cwd),
      ),
    );
  }
  const reading = READ_TOOLS.includes(event.tool);
  if (!reading && !WRITE_TOOLS.includes(event.tool)) return [];
  let path: string | undefined;
  for (const key of ['file_path', 'notebook_path', 'path', 'target_file']) {
    const value = input[key];
    if (typeof value === 'string' && value !== '') {
      path = value;
      break;
    }
  }
  return [
    row(
      event,
      agent,
      at,
      reading ? 'file.read' : 'file.edit',
      reading ? TOOL_CLASS.READ : TOOL_CLASS.WRITE,
      path === undefined ? undefined : shown(path, root, event.cwd),
    ),
  ];
}

/** Relative to the repository where the file is inside it, so no home directory is sent. */
function shown(path: string, root: string | undefined, cwd: string | undefined): string {
  const base = root ?? cwd;
  if (base === undefined || !isAbsolute(path)) return path;
  const inside = relative(base, path);
  return inside.startsWith('..') ? path : inside;
}

function row(
  event: SessionEvent,
  agent: string,
  at: string,
  operation: string,
  toolClass: (typeof TOOL_CLASS)[keyof typeof TOOL_CLASS],
  target: string | undefined,
): MemnoxEvent {
  return {
    id: `evt_${randomUUID().replace(/-/g, '').slice(0, 20)}`,
    schemaVersion: EVENT_SCHEMA_VERSION,
    at,
    sessionId: event.sessionId,
    agent,
    actorType: ACTOR_TYPE.AGENT,
    surface: EVENT_SURFACE.FILESYSTEM,
    operation,
    class: toolClass,
    effect: DECISION_EFFECT.ALLOW,
    mode: ENFORCEMENT_MODE.ENFORCE,
    reason: `${event.tool ?? 'a tool'} ran in the agent`,
    // A digest of the path, never the file: a row carries names, not contents.
    argsDigest: digest(target ?? ''),
    ...(target === undefined ? {} : { target }),
  };
}
