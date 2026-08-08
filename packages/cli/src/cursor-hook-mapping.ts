import type { ActionRequest, DecisionEffect } from '@memnox/core';
import { DECISION_EFFECT } from '@memnox/core';
import { CONTENT_METADATA_KEY } from '@memnox/content-shield';
import { readBranch } from './git-branch';
import { hookArguments, type BranchReader } from './hook-mapping';

/** Cursor hook events that can still refuse an action. */
export const CURSOR_BLOCKING_EVENTS = {
  PRE_TOOL_USE: 'preToolUse',
  BEFORE_SHELL: 'beforeShellExecution',
  BEFORE_MCP: 'beforeMCPExecution',
  BEFORE_READ_FILE: 'beforeReadFile',
} as const;

/** Fires after the edit has landed — reportable, not preventable. */
export const CURSOR_AFTER_FILE_EDIT = 'afterFileEdit';

export const CURSOR_HOOKS_VERSION = 1;
export const CURSOR_HOOK_TIMEOUT_S = 15;

/** Cursor's own vocabulary for the same three outcomes Memnox produces. */
export const CURSOR_PERMISSION = {
  ALLOW: 'allow',
  DENY: 'deny',
  ASK: 'ask',
} as const;

export type CursorPermission = (typeof CURSOR_PERMISSION)[keyof typeof CURSOR_PERMISSION];

const TARGET_MAX_LENGTH = 200;
const CONTENT_MAX_LENGTH = 100_000;

const ACTION_SHELL_EXECUTE = 'shell.execute';
const ACTION_FILE_WRITE = 'file.write';
const ACTION_FILE_READ = 'file.read';
const ACTION_MCP_PREFIX = 'mcp.';
const ACTION_TOOL_PREFIX = 'tool.';

export interface CursorHookPayload {
  hook_event_name?: string;
  conversation_id?: string;
  cwd?: string;
  command?: string;
  file_path?: string;
  tool_name?: string;
  tool_input?: unknown;
  edits?: Array<{ old_string?: string; new_string?: string }>;
}

export interface CursorHookResponse {
  permission: CursorPermission;
  agent_message?: string;
  user_message?: string;
}

/**
 * Memnox's effects in Cursor's vocabulary. Redact denies: the hook answers with
 * a permission and cannot hand back a rewritten call, so the one thing it must
 * not do is let the unmasked payload through — see REDACT_FALLBACK_EFFECT.
 */
export function toCursorPermission(effect: DecisionEffect): CursorPermission {
  if (effect === DECISION_EFFECT.BLOCK) return CURSOR_PERMISSION.DENY;
  if (effect === DECISION_EFFECT.REDACT) return CURSOR_PERMISSION.DENY;
  if (effect === DECISION_EFFECT.REQUIRE_APPROVAL) return CURSOR_PERMISSION.ASK;
  return CURSOR_PERMISSION.ALLOW;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

/** tool_input is an object on preToolUse but a JSON string on beforeMCPExecution. */
function parseToolInput(raw: unknown): Record<string, unknown> {
  if (typeof raw !== 'string') return asRecord(raw);
  try {
    return asRecord(JSON.parse(raw));
  } catch {
    return {}; // Unparseable params still yield a governable action, just without a target.
  }
}

function stringField(source: Record<string, unknown>, key: string): string | null {
  const value = source[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function writtenContent(input: Record<string, unknown>): string | null {
  return (
    stringField(input, 'content') ??
    stringField(input, 'new_string') ??
    stringField(input, 'contents')
  );
}

function fileWrite(filePath: string, content: string | null): ActionRequest {
  return {
    action: ACTION_FILE_WRITE,
    target: filePath,
    metadata: content
      ? { [CONTENT_METADATA_KEY]: content.slice(0, CONTENT_MAX_LENGTH) }
      : undefined,
  };
}

function fromPreToolUse(payload: CursorHookPayload): ActionRequest | null {
  const toolName = payload.tool_name;
  if (!toolName) return null;
  const input = parseToolInput(payload.tool_input);

  const command = stringField(input, 'command');
  if (command) {
    return { action: ACTION_SHELL_EXECUTE, target: command.slice(0, TARGET_MAX_LENGTH) };
  }
  const filePath = stringField(input, 'file_path') ?? stringField(input, 'path');
  if (filePath) return fileWrite(filePath, writtenContent(input));

  return { action: `${ACTION_TOOL_PREFIX}${toolName.toLowerCase()}` };
}

/** Maps a Cursor hook invocation onto the universal action event. */
export function mapCursorPayload(
  payload: CursorHookPayload,
  branchOf: BranchReader = readBranch,
): ActionRequest | null {
  const request = mapEvent(payload);
  if (!request) return null;

  const branch = branchOf(payload.cwd);
  return {
    ...request,
    arguments: cursorArguments(payload),
    ...(payload.conversation_id === undefined
      ? {}
      : { sessionId: payload.conversation_id }),
    ...(payload.cwd === undefined ? {} : { workingDirectory: payload.cwd }),
    ...(branch === undefined ? {} : { branch }),
  };
}

/**
 * Cursor spreads the call across the payload — a shell command sits beside the
 * tool input, not inside it — so both are folded into one argument map for the
 * rules to match on.
 */
function cursorArguments(payload: CursorHookPayload): Record<string, string> {
  return {
    ...hookArguments(parseToolInput(payload.tool_input)),
    ...(payload.command === undefined ? {} : { command: payload.command }),
    ...(payload.file_path === undefined ? {} : { file_path: payload.file_path }),
  };
}

function mapEvent(payload: CursorHookPayload): ActionRequest | null {
  switch (payload.hook_event_name) {
    case CURSOR_BLOCKING_EVENTS.BEFORE_SHELL: {
      const command = payload.command;
      if (!command) return null;
      return {
        action: ACTION_SHELL_EXECUTE,
        target: command.slice(0, TARGET_MAX_LENGTH),
      };
    }
    case CURSOR_BLOCKING_EVENTS.BEFORE_MCP: {
      const toolName = payload.tool_name;
      if (!toolName) return null;
      const input = parseToolInput(payload.tool_input);
      return {
        action: `${ACTION_MCP_PREFIX}${toolName.toLowerCase()}`,
        target: stringField(input, 'path') ?? stringField(input, 'url') ?? undefined,
      };
    }
    case CURSOR_BLOCKING_EVENTS.BEFORE_READ_FILE: {
      const filePath = payload.file_path;
      if (!filePath) return null;
      return { action: ACTION_FILE_READ, target: filePath };
    }
    case CURSOR_AFTER_FILE_EDIT: {
      const filePath = payload.file_path;
      if (!filePath) return null;
      const applied = (payload.edits ?? [])
        .map((edit) => edit.new_string)
        .filter((part): part is string => typeof part === 'string')
        .join('\n');
      return fileWrite(filePath, applied.length > 0 ? applied : null);
    }
    case CURSOR_BLOCKING_EVENTS.PRE_TOOL_USE:
      return fromPreToolUse(payload);
    default:
      return null;
  }
}
