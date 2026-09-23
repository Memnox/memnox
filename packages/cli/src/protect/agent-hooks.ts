import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DISCOVERED_AGENT_KIND } from '@memnox/core';
import {
  CURSOR_EDIT_TOOLS,
  CURSOR_EVENT,
  EDIT_HOOK_BINARY,
  EDIT_HOOK_EVENT,
  WINDSURF_EVENT,
} from '@memnox/interceptors';
import {
  CLAUDE_SETTINGS,
  claudeEvents,
  holdsPolicyHook,
  installClaudeHook,
  namedHookCommand,
  installSettingsHook,
  removeClaudeHook,
  removeSettingsHook,
  type HookEvent,
} from './claude-hook';
import { isInPlace, REWRITE, rewriteJsonFile } from './json-config';

/**
 * The same lease hook in Codex, Gemini CLI, Windsurf and Cursor, each only where it is
 * installed. Each command names its agent, so a refusal elsewhere says which one.
 */

/** Codex reads hooks from a file shaped like Claude Code's settings. */
const CODEX_HOOKS = join('.codex', 'hooks.json');
/**
 * Codex's `PreToolUse` with no matcher, which every tool meets: its shell, its patch tool
 * and its MCP calls are all ruled on, so no pattern syntax has to be guessed.
 */
function codexEvents(): HookEvent[] {
  return claudeEvents().map((each) =>
    each.event === EDIT_HOOK_EVENT.PRE_TOOL_USE ? { event: each.event } : each,
  );
}

/** Cursor's user-level hooks, which apply in every repository it opens. */
const CURSOR_HOOKS = join('.cursor', 'hooks.json');
const CURSOR_HOOKS_VERSION = 1;

export async function installCodexHook(home: string): Promise<boolean> {
  return installSettingsHook(
    join(home, CODEX_HOOKS),
    namedHookCommand(DISCOVERED_AGENT_KIND.CODEX_CLI),
    codexEvents(),
  );
}

/** Gemini CLI reads hooks from its own settings, in the same shape under its own event names. */
const GEMINI_SETTINGS = join('.gemini', 'settings.json');
const GEMINI_AGENT = 'gemini-cli';
/** Every tool, for the moment after one returns; Gemini's matchers are regular expressions. */
const GEMINI_EVERY_TOOL = '.*';

const GEMINI_EVENTS: readonly HookEvent[] = [
  { event: 'BeforeTool', matcher: GEMINI_EVERY_TOOL },
  { event: 'AfterTool', matcher: GEMINI_EVERY_TOOL },
  { event: 'BeforeAgent' },
  { event: 'AfterAgent' },
  { event: 'SessionEnd' },
  // Gemini CLI reads added context from a session start the way Claude Code does.
  { event: EDIT_HOOK_EVENT.SESSION_START },
];

export async function installGeminiHook(home: string): Promise<boolean> {
  return installSettingsHook(
    join(home, GEMINI_SETTINGS),
    namedHookCommand(GEMINI_AGENT),
    GEMINI_EVENTS,
  );
}

export async function removeGeminiHook(home: string): Promise<boolean> {
  return removeSettingsHook(join(home, GEMINI_SETTINGS));
}

/** Windsurf's user-level hooks, which Cascade reads in every workspace. */
const WINDSURF_HOOKS = join('.codeium', 'windsurf', 'hooks.json');
const WINDSURF_AGENT = 'windsurf';

/**
 * Before and after a write, a read, a command or an MCP call. Windsurf has no
 * event that ends a session, so what it holds lapses on the idle window.
 */
const WINDSURF_EVENTS: readonly string[] = Object.values(WINDSURF_EVENT);

export async function installWindsurfHook(home: string): Promise<boolean> {
  const command = namedHookCommand(WINDSURF_AGENT);
  const entries = WINDSURF_EVENTS.map((event) => ({
    event,
    entry: { command, show_output: false },
  }));
  const outcome = await rewriteJsonFile<JsonHooks>(join(home, WINDSURF_HOOKS), (config) =>
    withJsonHooks(config, entries),
  );
  return isInPlace(outcome);
}

export async function removeWindsurfHook(home: string): Promise<boolean> {
  return removeJsonHooks(join(home, WINDSURF_HOOKS));
}

export async function removeCodexHook(home: string): Promise<boolean> {
  return removeSettingsHook(join(home, CODEX_HOOKS));
}

interface JsonHook {
  command?: unknown;
  matcher?: string;
  [key: string]: unknown;
}

/** The hooks file Cursor and Windsurf share: a flat list of commands per event. */
type JsonHooks = Record<string, unknown> & {
  version?: number;
  hooks?: Record<string, JsonHook[]>;
};

interface EventEntry {
  event: string;
  entry: JsonHook;
}

function isOurs(hook: JsonHook): boolean {
  return typeof hook.command === 'string' && hook.command.includes(EDIT_HOOK_BINARY);
}

/** The hooks with every entry this wrote taken out, and nothing else. */
function withoutJsonHooks(config: JsonHooks): JsonHooks {
  const hooks = config.hooks;
  if (hooks === undefined || typeof hooks !== 'object') return config;
  const kept: Record<string, JsonHook[]> = {};
  for (const [event, entries] of Object.entries(hooks)) {
    if (!Array.isArray(entries)) {
      kept[event] = entries;
      continue;
    }
    const remaining = entries.filter((entry) => !isOurs(entry));
    if (remaining.length > 0) kept[event] = remaining;
  }
  return { ...config, hooks: kept };
}

/** The hooks with ours replaced by these entries, so adding twice changes nothing. */
function withJsonHooks(config: JsonHooks, entries: readonly EventEntry[]): JsonHooks {
  const cleared = withoutJsonHooks(config);
  const hooks = { ...(cleared.hooks ?? {}) };
  for (const { event, entry } of entries) {
    hooks[event] = [...(hooks[event] ?? []), entry];
  }
  return { ...cleared, hooks };
}

/**
 * Before a write and after one, since `afterFileEdit` always says what changed; before a
 * command, an MCP call and a read, where a rule can refuse it; after every tool call and
 * turn, where a waiting note is handed over; and at the end.
 */
function cursorEntries(command: string): EventEntry[] {
  return [
    {
      event: CURSOR_EVENT.PRE_TOOL_USE,
      entry: { command, matcher: CURSOR_EDIT_TOOLS.join('|') },
    },
    { event: CURSOR_EVENT.BEFORE_SHELL, entry: { command } },
    { event: CURSOR_EVENT.BEFORE_MCP, entry: { command } },
    { event: CURSOR_EVENT.BEFORE_READ, entry: { command } },
    { event: CURSOR_EVENT.AFTER_FILE_EDIT, entry: { command } },
    { event: CURSOR_EVENT.SESSION_END, entry: { command } },
    { event: CURSOR_EVENT.POST_TOOL_USE, entry: { command } },
    { event: CURSOR_EVENT.STOP, entry: { command } },
  ];
}

export async function installCursorHook(home: string): Promise<boolean> {
  const entries = cursorEntries(namedHookCommand(DISCOVERED_AGENT_KIND.CURSOR));
  const outcome = await rewriteJsonFile<JsonHooks>(join(home, CURSOR_HOOKS), (config) =>
    withJsonHooks(
      { ...config, version: config.version ?? CURSOR_HOOKS_VERSION },
      entries,
    ),
  );
  return isInPlace(outcome);
}

export async function removeCursorHook(home: string): Promise<boolean> {
  return removeJsonHooks(join(home, CURSOR_HOOKS));
}

/** Takes this hook's entries out of a Cursor or Windsurf shaped hooks file. */
async function removeJsonHooks(path: string): Promise<boolean> {
  return (await rewriteJsonFile(path, withoutJsonHooks)) === REWRITE.WRITTEN;
}

/** One coding agent that takes the edit hook, where its file lives and how to put it there. */
export interface EditHookTarget {
  /** The name a screen and a desktop notice print. */
  name: string;
  /** The file under the home directory the hook is written into. */
  file: string;
  /** The agent its command names, which a current hook must carry. */
  agent: string;
  install: (home: string) => Promise<boolean>;
  remove: (home: string) => Promise<boolean>;
  /** Events a current hook must carry, so an install from before one was added is upgraded. */
  currentEvents?: readonly string[];
}

/** Where the boundary is handed to a session: Claude Code, Codex and Gemini CLI have it. */
const STARTS_A_SESSION: readonly string[] = [EDIT_HOOK_EVENT.SESSION_START];

/** Every agent the hook goes into, in the order setup reports them. */
export const EDIT_HOOK_TARGETS: readonly EditHookTarget[] = [
  {
    name: 'Claude Code',
    agent: DISCOVERED_AGENT_KIND.CLAUDE_CODE,
    file: CLAUDE_SETTINGS,
    install: installClaudeHook,
    remove: removeClaudeHook,
    currentEvents: STARTS_A_SESSION,
  },
  {
    name: 'Codex',
    agent: DISCOVERED_AGENT_KIND.CODEX_CLI,
    file: CODEX_HOOKS,
    install: installCodexHook,
    remove: removeCodexHook,
    currentEvents: STARTS_A_SESSION,
  },
  {
    name: 'Cursor',
    agent: DISCOVERED_AGENT_KIND.CURSOR,
    file: CURSOR_HOOKS,
    install: installCursorHook,
    remove: removeCursorHook,
  },
  {
    name: 'Gemini CLI',
    agent: GEMINI_AGENT,
    file: GEMINI_SETTINGS,
    install: installGeminiHook,
    remove: removeGeminiHook,
    currentEvents: STARTS_A_SESSION,
  },
  {
    name: 'Windsurf',
    agent: WINDSURF_AGENT,
    file: WINDSURF_HOOKS,
    install: installWindsurfHook,
    remove: removeWindsurfHook,
  },
];

/** Whether this agent's own hooks file runs the policy hook, which is what explain counts. */
export async function holdsOwnPolicyHook(home: string, kind: string): Promise<boolean> {
  const target = EDIT_HOOK_TARGETS.find((each) => each.agent === kind);
  if (target === undefined) return false;
  try {
    return holdsPolicyHook(await readFile(join(home, target.file), 'utf8'), target.agent);
  } catch {
    // No file is an agent that was never hooked, which is the honest answer here.
    return false;
  }
}
