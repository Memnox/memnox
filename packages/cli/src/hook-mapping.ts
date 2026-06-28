import type { ActionRequest } from '@memnox/core';
import { CONTENT_METADATA_KEY } from '@memnox/content-shield';

const HOOK_TARGET_MAX_LENGTH = 200;
/** Written content is forwarded for secret scanning, capped to keep requests small. */
const HOOK_CONTENT_MAX_LENGTH = 100_000;
/** Claude Code tools the PreToolUse hook intercepts. */
export const HOOK_MATCHER = 'Edit|Write|MultiEdit|NotebookEdit|Bash';
export const HOOK_TIMEOUT_S = 15;
/** Claude Code convention: exit 2 + stderr denies the tool call. */
export const HOOK_EXIT_BLOCK = 2;

const ACTION_SHELL_EXECUTE = 'shell.execute';
const ACTION_FILE_WRITE = 'file.write';
const ACTION_TOOL_PREFIX = 'tool.';

const FILE_TOOLS: readonly string[] = ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'];

export interface ClaudeCodeHookPayload {
  cwd?: string;
  session_id?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
}

/** Maps a Claude Code tool call onto the universal action event. */
export function mapHookPayload(payload: ClaudeCodeHookPayload): ActionRequest | null {
  const toolName = payload.tool_name;
  if (!toolName) return null;
  const input = payload.tool_input ?? {};

  if (toolName === 'Bash') {
    const command = input['command'];
    if (typeof command !== 'string') return null;
    return withSession(payload.session_id, shellAction(command));
  }
  if (FILE_TOOLS.includes(toolName)) {
    const filePath = input['file_path'] ?? input['notebook_path'];
    if (typeof filePath !== 'string') return null;
    return withSession(
      payload.session_id,
      fileWriteAction(filePath, extractWrittenContent(input)),
    );
  }
  return withSession(payload.session_id, toolAction(toolName));
}

function shellAction(command: string): ActionRequest {
  return {
    action: ACTION_SHELL_EXECUTE,
    target: command.slice(0, HOOK_TARGET_MAX_LENGTH),
  };
}

function fileWriteAction(filePath: string, content: string | null): ActionRequest {
  return {
    action: ACTION_FILE_WRITE,
    target: filePath,
    metadata: content
      ? { [CONTENT_METADATA_KEY]: content.slice(0, HOOK_CONTENT_MAX_LENGTH) }
      : undefined,
  };
}

function toolAction(toolName: string): ActionRequest {
  return { action: `${ACTION_TOOL_PREFIX}${toolName.toLowerCase()}` };
}

function withSession(
  sessionId: string | undefined,
  request: ActionRequest,
): ActionRequest {
  return { ...request, sessionId };
}

/** The proposed post-edit text across Write/Edit/MultiEdit/NotebookEdit shapes. */
function extractWrittenContent(input: Record<string, unknown>): string | null {
  if (typeof input['content'] === 'string') return input['content'];
  if (typeof input['new_string'] === 'string') return input['new_string'];
  if (typeof input['new_source'] === 'string') return input['new_source'];
  if (Array.isArray(input['edits'])) {
    const parts = (input['edits'] as Array<Record<string, unknown>>)
      .map((edit) => edit['new_string'])
      .filter((part): part is string => typeof part === 'string');
    if (parts.length > 0) return parts.join('\n');
  }
  return null;
}
