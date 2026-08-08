import type { ActionRequest } from '@memnox/core';
import { CONTENT_METADATA_KEY } from '@memnox/content-shield';
import { readBranch } from './git-branch';

const HOOK_TARGET_MAX_LENGTH = 200;
/** Written content is scanned in this process, capped to keep the scan bounded. */
const HOOK_CONTENT_MAX_LENGTH = 100_000;
/** Enough for a command line or a path to match a rule, short enough to stay cheap. */
const HOOK_ARGUMENT_MAX_LENGTH = 4_000;
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

/** Reads the branch for a working directory; injected so tests never need a repo. */
export type BranchReader = (cwd: string | undefined) => string | undefined;

/** Maps a Claude Code tool call onto the universal action event. */
export function mapHookPayload(
  payload: ClaudeCodeHookPayload,
  branchOf: BranchReader = readBranch,
): ActionRequest | null {
  const request = mapTool(payload);
  if (request === null) return null;
  return withContext(payload, branchOf, {
    ...request,
    arguments: hookArguments(payload.tool_input),
  });
}

function mapTool(payload: ClaudeCodeHookPayload): ActionRequest | null {
  const toolName = payload.tool_name;
  if (!toolName) return null;
  const input = payload.tool_input ?? {};

  if (toolName === 'Bash') {
    const command = input['command'];
    if (typeof command !== 'string') return null;
    return shellAction(command);
  }
  if (FILE_TOOLS.includes(toolName)) {
    const filePath = input['file_path'] ?? input['notebook_path'];
    if (typeof filePath !== 'string') return null;
    return fileWriteAction(filePath, extractWrittenContent(input));
  }
  return toolAction(toolName);
}

/**
 * Where the agent is working, which is half of what a rule needs: the same
 * command is routine in a scratch clone and serious on the release branch.
 */
function withContext(
  payload: ClaudeCodeHookPayload,
  branchOf: BranchReader,
  request: ActionRequest,
): ActionRequest {
  const branch = branchOf(payload.cwd);
  return {
    ...request,
    sessionId: payload.session_id,
    ...(payload.cwd === undefined ? {} : { workingDirectory: payload.cwd }),
    ...(branch === undefined ? {} : { branch }),
  };
}

/**
 * The tool's own arguments, flattened for matching. They are read here and
 * never sent: the SDK strips them, so `arguments:` rules are decided by the
 * local gate in this process.
 */
export function hookArguments(
  input: Record<string, unknown> | undefined,
): Record<string, string> {
  if (input === undefined) return {};
  const flattened: Record<string, string> = {};
  for (const [name, value] of Object.entries(input)) {
    flattened[name] = asText(value).slice(0, HOOK_ARGUMENT_MAX_LENGTH);
  }
  return flattened;
}

function asText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === undefined) return '';
  if (typeof value === 'object' && value !== null) return JSON.stringify(value);
  return String(value);
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
