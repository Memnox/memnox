import { isAbsolute, join, resolve } from 'node:path';

import { ACTION, TOOL_CLASS, type ToolClass } from '@memnox/core';

import {
  CURSOR_EDIT_TOOLS,
  CURSOR_EVENT,
  EDIT_HOST,
  GEMINI_EDIT_TOOLS,
  GEMINI_EVENT,
  WINDSURF_EVENT,
  type EditHost,
} from './agent-edits';
import { patchEditsOf } from './codex-patch';
import { EDIT_HOOK_EVENT, EDIT_TOOLS } from './edit-hook';
import {
  CODEX_PATCH_TOOL,
  cwdOf,
  fieldsOf,
  firstText,
  folderOf,
  sessionOf,
  type HookFields,
} from './hook-payload';
import { EGRESS_REQUEST_ACTION } from './tool-hook.constants';

/**
 * What an agent's own tool is about to do, read out of its hook payload as the actions a
 * rule names: a read by its path, a fetch by its host, a command line, an MCP call.
 * A tool this does not know is not ruled on, so the agent's own permissions decide it.
 */

/** One action a tool call takes, in the words the policy engine matches. */
export interface ToolRequest {
  action: string;
  target?: string;
  class: ToolClass;
  /** Local only: ruled on for what it carries and never written to a row. */
  arguments?: Record<string, string>;
}

/** A tool call about to run, and what it does. */
export interface ToolCall {
  host: EditHost;
  /** The tool as the agent named it, for the row and the refusal. */
  tool: string;
  sessionId: string;
  cwd?: string;
  /** The actions a file, fetch or MCP tool takes. Empty for a command line. */
  requests: ToolRequest[];
  /** A command line, ruled on through the shell classifier every seam uses. */
  shell?: string;
  /** True where this event's reply can put the question to a person. */
  nativeAsk: boolean;
  /** What this event reads as a go-ahead, where silence would be read as a refusal. */
  allowReply?: string;
}

/** Tools that read one file or folder by path. */
const READ_TOOLS: readonly string[] = [
  'Read',
  'NotebookRead',
  'LS',
  'read_file',
  'list_directory',
];

/** Tools that search under a folder, which is the working directory when none is named. */
const SEARCH_TOOLS: readonly string[] = ['Grep', 'Glob', 'glob', 'search_file_content'];

/** Every file tool that writes, across the agents whose hooks are read here. */
const WRITE_TOOLS: readonly string[] = [
  ...EDIT_TOOLS,
  ...GEMINI_EDIT_TOOLS,
  ...CURSOR_EDIT_TOOLS,
];

const FETCH_TOOLS: readonly string[] = ['WebFetch', 'web_fetch'];
const WEB_SEARCH_TOOLS: readonly string[] = ['WebSearch', 'google_web_search'];
const SHELL_TOOLS: readonly string[] = ['Bash', 'run_shell_command', 'shell'];

/** Where a file tool names its path, first match wins. */
const PATH_KEYS: readonly string[] = [
  'file_path',
  'notebook_path',
  'absolute_path',
  'path',
  'dir_path',
  'target_file',
];

/** Claude Code, Codex and Gemini CLI spell an MCP tool `mcp__<server>__<tool>`. */
const MCP_TOOL = /^mcp__(.+?)__(.+)$/;
const MCP_PREFIX = 'mcp';

/** A URL inside free text, which is where Gemini's fetch tool carries its address. */
const URL_IN_TEXT = /https?:\/\/[^\s"'<>]+/;

/** Cursor reads an empty object as "no objection", and anything that is not JSON as a block. */
const CURSOR_NO_OBJECTION = '{}';

/** The tool call in this payload, or null where it is not one before a tool runs. */
export function toolCallOf(payload: unknown, home: string): ToolCall | null {
  const hook = fieldsOf(payload);
  if (hook === null) return null;
  const windsurf = hook['agent_action_name'];
  if (typeof windsurf === 'string') return windsurfCall(hook, windsurf, home);
  const event = hook['hook_event_name'];
  if (event === EDIT_HOOK_EVENT.PRE_TOOL_USE) {
    return namedCall(hook, EDIT_HOST.PRE_TOOL_USE, home);
  }
  if (event === GEMINI_EVENT.BEFORE_TOOL) return namedCall(hook, EDIT_HOST.GEMINI, home);
  // Cursor's `preToolUse` carries only its writes, whose go-ahead the lease answers.
  if (event === CURSOR_EVENT.PRE_TOOL_USE) return namedCall(hook, EDIT_HOST.CURSOR, home);
  if (typeof event === 'string') return cursorCall(hook, event, home);
  return null;
}

/** A tool named by `tool_name` with its input under `tool_input`. */
function namedCall(hook: HookFields, host: EditHost, home: string): ToolCall | null {
  const tool = hook['tool_name'];
  if (typeof tool !== 'string' || tool === '') return null;
  const input = fieldsOf(hook['tool_input']) ?? {};
  const cwd = cwdOf(hook);
  // Claude Code reads `ask` as a prompt for its person; whether one is there is the caller's.
  const base = {
    ...baseOf({ host, tool, hook, cwd }),
    nativeAsk: host === EDIT_HOST.PRE_TOOL_USE,
  };
  if (SHELL_TOOLS.includes(tool)) return shellCall(base, firstText(input, ['command']));
  if (tool === CODEX_PATCH_TOOL) {
    const files = patchEditsOf(hook) ?? [];
    return withRequests(
      base,
      files.map((file) => fileRequest(ACTION.FILESYSTEM_WRITE, file.path, { cwd, home })),
    );
  }
  const requests = requestsFor(tool, input, { cwd, home });
  return requests === null ? null : withRequests(base, requests);
}

/** Where a relative path is relative to, and whose home `~` means. */
interface PathBase {
  cwd: string | undefined;
  home: string;
}

/** What a named tool does, or null for a tool no rule could be about. */
function requestsFor(
  tool: string,
  input: HookFields,
  base: PathBase,
): ToolRequest[] | null {
  const mcp = MCP_TOOL.exec(tool);
  if (mcp !== null) return mcpRequests(mcp[1] ?? '', mcp[2] ?? '', input);
  const path = firstText(input, PATH_KEYS);
  if (READ_TOOLS.includes(tool) && path !== undefined) {
    return [fileRequest(ACTION.FILESYSTEM_READ, path, base)];
  }
  if (SEARCH_TOOLS.includes(tool)) {
    const where = path ?? base.cwd;
    return where === undefined
      ? null
      : [fileRequest(ACTION.FILESYSTEM_READ, where, base)];
  }
  if (WRITE_TOOLS.includes(tool) && path !== undefined) {
    return [fileRequest(ACTION.FILESYSTEM_WRITE, path, base)];
  }
  if (FETCH_TOOLS.includes(tool)) return [fetchRequest(input)];
  if (WEB_SEARCH_TOOLS.includes(tool)) return [searchRequest(input)];
  return null;
}

/** Absolute, with `~` spelled out, because a rule's `**\/.ssh/**` matches whole paths. */
export function absolutePath(path: string, base: PathBase): string {
  if (path === '~') return base.home;
  if (path.startsWith('~/')) return join(base.home, path.slice(2));
  if (isAbsolute(path) || base.cwd === undefined) return path;
  return resolve(base.cwd, path);
}

function fileRequest(action: string, path: string, base: PathBase): ToolRequest {
  const toolClass =
    action === ACTION.FILESYSTEM_READ ? TOOL_CLASS.READ : TOOL_CLASS.WRITE;
  return { action, target: absolutePath(path, base), class: toolClass };
}

/**
 * Both spellings of one MCP call, the strictest winning: `mcp.<server>.<tool>` as native
 * rules write it, and `mcp.<tool>` of the server as the proxy asks, or one seam's rule missed.
 */
function mcpRequests(server: string, tool: string, input: HookFields): ToolRequest[] {
  const common = {
    target: server,
    class: TOOL_CLASS.UNKNOWN,
    arguments: flatArguments(input),
  };
  return [
    { action: `${MCP_PREFIX}.${server}.${tool}`, ...common },
    { action: `${MCP_PREFIX}.${tool}`, ...common },
  ];
}

/** Each field as text, the shape a rule's argument patterns and the egress check read. */
function flatArguments(input: HookFields): Record<string, string> {
  return Object.fromEntries(
    Object.entries(input).map(([key, value]) => [
      key,
      typeof value === 'string' ? value : JSON.stringify(value),
    ]),
  );
}

/** A fetch by its host, which is what a network rule names; the URL is inspected too. */
function fetchRequest(input: HookFields): ToolRequest {
  const text = firstText(input, ['url', 'prompt']) ?? '';
  const found = URL_IN_TEXT.exec(text);
  const url = found === null ? undefined : found[0];
  const host = url === undefined ? undefined : hostOf(url);
  return {
    action: EGRESS_REQUEST_ACTION,
    ...(host === undefined ? {} : { target: host }),
    class: TOOL_CLASS.READ,
    arguments: url === undefined ? {} : { url },
  };
}

/** A web search names no host, so only a rule over every request reaches it. */
function searchRequest(input: HookFields): ToolRequest {
  const query = firstText(input, ['query']);
  return {
    action: EGRESS_REQUEST_ACTION,
    class: TOOL_CLASS.READ,
    arguments: query === undefined ? {} : { query },
  };
}

function hostOf(url: string): string | undefined {
  try {
    const host = new URL(url).hostname;
    return host === '' ? undefined : host;
  } catch {
    // Not a URL after all, so there is no host to name and none is guessed.
    return undefined;
  }
}

interface BaseInput {
  host: EditHost;
  tool: string;
  hook: HookFields;
  cwd: string | undefined;
}

function baseOf(input: BaseInput): ToolCall {
  return {
    host: input.host,
    tool: input.tool,
    sessionId: sessionOf(input.hook),
    ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
    requests: [],
    nativeAsk: false,
  };
}

function withRequests(base: ToolCall, requests: ToolRequest[]): ToolCall | null {
  return requests.length === 0 ? null : { ...base, requests };
}

function shellCall(base: ToolCall, line: string | undefined): ToolCall | null {
  if (line === undefined || line.trim() === '') return null;
  return { ...base, shell: line };
}

/** Cursor's own events before a command, an MCP call and a read, each with its own fields. */
function cursorCall(hook: HookFields, event: string, home: string): ToolCall | null {
  const cwd = cwdOf(hook);
  if (event === CURSOR_EVENT.BEFORE_SHELL) {
    const call = shellCall(cursorBase(hook, 'shell', cwd), firstText(hook, ['command']));
    return call === null ? null : { ...call, nativeAsk: true };
  }
  if (event === CURSOR_EVENT.BEFORE_MCP) {
    const tool = firstText(hook, ['tool_name']);
    if (tool === undefined) return null;
    // Cursor names the server by its address rather than its name, so every server is `*`.
    const requests = mcpRequests('*', tool, fieldsOf(hook['tool_input']) ?? {});
    return { ...cursorBase(hook, tool, cwd), requests, nativeAsk: true };
  }
  if (event === CURSOR_EVENT.BEFORE_READ) {
    const path = firstText(hook, ['file_path']);
    if (path === undefined) return null;
    const request = fileRequest(ACTION.FILESYSTEM_READ, path, { cwd, home });
    return { ...cursorBase(hook, 'read', cwd), requests: [request] };
  }
  return null;
}

function cursorBase(hook: HookFields, tool: string, cwd: string | undefined): ToolCall {
  return {
    ...baseOf({ host: EDIT_HOST.CURSOR, tool, hook, cwd }),
    allowReply: CURSOR_NO_OBJECTION,
  };
}

/** Windsurf's events before a read, a write, a command and an MCP call. */
function windsurfCall(hook: HookFields, action: string, home: string): ToolCall | null {
  const info = fieldsOf(hook['tool_info']) ?? {};
  const path = firstText(info, ['file_path']);
  const cwd =
    firstText(info, ['cwd']) ?? (path === undefined ? undefined : folderOf(path));
  const base: ToolCall = {
    ...baseOf({ host: EDIT_HOST.WINDSURF, tool: action, hook, cwd }),
    sessionId: firstText(hook, ['trajectory_id']) ?? '',
  };
  if (action === WINDSURF_EVENT.PRE_COMMAND) {
    return shellCall(base, firstText(info, ['command_line']));
  }
  if (action === WINDSURF_EVENT.PRE_MCP) {
    const server = firstText(info, ['mcp_server_name']);
    const tool = firstText(info, ['mcp_tool_name']);
    if (server === undefined || tool === undefined) return null;
    const input = fieldsOf(info['mcp_tool_arguments']) ?? {};
    return withRequests(base, mcpRequests(server, tool, input));
  }
  if (path === undefined) return null;
  if (action === WINDSURF_EVENT.PRE_READ) {
    return withRequests(base, [fileRequest(ACTION.FILESYSTEM_READ, path, { cwd, home })]);
  }
  if (action === WINDSURF_EVENT.PRE_WRITE) {
    return withRequests(base, [
      fileRequest(ACTION.FILESYSTEM_WRITE, path, { cwd, home }),
    ]);
  }
  return null;
}
