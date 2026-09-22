import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { AGENT_FLAG, DISCOVERED_AGENT_KIND } from '@memnox/core';
import {
  CURSOR_EDIT_TOOLS,
  CURSOR_EVENT,
  EDIT_HOOK_BINARY,
  GEMINI_EDIT_TOOLS,
  WINDSURF_EVENT,
} from '@memnox/interceptors';
import {
  claudeEvents,
  editHookCommand,
  installSettingsHook,
  removeSettingsHook,
  type HookEvent,
} from './claude-hook';

/**
 * The same lease hook in Codex and Cursor, so an edit either of them makes meets one
 * another agent is making on another computer.
 *
 * Claude Code's hook was the only one, so two agents on two machines only met when
 * both were Claude Code. The rules are the ones the Claude Code installer keeps: only
 * where the agent is installed, the file backed up before it is touched, only entries
 * this wrote are ever taken out, and a file that is not plain JSON is left alone.
 *
 * Each command names its agent, so a refusal on the other machine says Cursor or
 * Codex rather than the name the hook would otherwise guess.
 */

/** Codex reads hooks from a file shaped like Claude Code's settings. */
const CODEX_HOOKS = join('.codex', 'hooks.json');
/** Codex writes files with one patch tool, and with the edit tools where it has them. */
const CODEX_MATCHER = 'apply_patch|Edit|Write';

/** Cursor's user-level hooks, which apply in every repository it opens. */
const CURSOR_HOOKS = join('.cursor', 'hooks.json');
const CURSOR_HOOKS_VERSION = 1;

function commandFor(agent: string): string {
  return `${editHookCommand()} ${AGENT_FLAG} ${agent}`;
}

export async function installCodexHook(home: string): Promise<boolean> {
  return installSettingsHook(
    join(home, CODEX_HOOKS),
    commandFor(DISCOVERED_AGENT_KIND.CODEX_CLI),
    claudeEvents(CODEX_MATCHER),
  );
}

/** Gemini CLI reads hooks from its own settings, in the same shape under its own event names. */
const GEMINI_SETTINGS = join('.gemini', 'settings.json');
const GEMINI_AGENT = 'gemini-cli';
/** Every tool, for the moment after one returns; Gemini's matchers are regular expressions. */
const GEMINI_EVERY_TOOL = '.*';

const GEMINI_EVENTS: readonly HookEvent[] = [
  { event: 'BeforeTool', matcher: GEMINI_EDIT_TOOLS.join('|') },
  { event: 'AfterTool', matcher: GEMINI_EVERY_TOOL },
  { event: 'BeforeAgent' },
  { event: 'AfterAgent' },
  { event: 'SessionEnd' },
];

export async function installGeminiHook(home: string): Promise<boolean> {
  return installSettingsHook(
    join(home, GEMINI_SETTINGS),
    commandFor(GEMINI_AGENT),
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
 * Before a write, to take its lines; after a write, a read, a command or an MCP
 * call, to record what it did and keep its holds alive. Windsurf has no event that
 * ends a session, so what it holds lapses on the idle window.
 */
const WINDSURF_EVENTS: readonly string[] = Object.values(WINDSURF_EVENT);

export async function installWindsurfHook(home: string): Promise<boolean> {
  const path = join(home, WINDSURF_HOOKS);
  if (!existsSync(dirname(path))) return false;
  try {
    const raw = existsSync(path) ? await readFile(path, 'utf8') : '{}';
    const config = JSON.parse(raw) as CursorHooks;
    const cleared = withoutCursorHook(config);
    const hooks = { ...(cleared.hooks ?? {}) };
    const command = commandFor(WINDSURF_AGENT);
    for (const event of WINDSURF_EVENTS) {
      hooks[event] = [...(hooks[event] ?? []), { command, show_output: false }];
    }
    const next: CursorHooks = { ...cleared, hooks };
    if (JSON.stringify(next) === JSON.stringify(config)) return true;
    if (existsSync(path)) await writeFile(`${path}.memnox-backup`, raw, 'utf8');
    await writeFile(path, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
    return true;
  } catch {
    // Not plain JSON: left alone, because writing it whole would drop what it held.
    return false;
  }
}

export async function removeWindsurfHook(home: string): Promise<boolean> {
  return removeJsonHooks(join(home, WINDSURF_HOOKS));
}

export async function removeCodexHook(home: string): Promise<boolean> {
  return removeSettingsHook(join(home, CODEX_HOOKS));
}

interface CursorHook {
  command?: unknown;
  matcher?: string;
  [key: string]: unknown;
}

type CursorHooks = Record<string, unknown> & {
  version?: number;
  hooks?: Record<string, CursorHook[]>;
};

function isOurs(hook: CursorHook): boolean {
  return typeof hook.command === 'string' && hook.command.includes(EDIT_HOOK_BINARY);
}

/** The Cursor hooks with every entry this wrote taken out, and nothing else. */
function withoutCursorHook(config: CursorHooks): CursorHooks {
  const hooks = config.hooks;
  if (hooks === undefined || typeof hooks !== 'object') return config;
  const kept: Record<string, CursorHook[]> = {};
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

/**
 * The Cursor hooks with this one added, before a write, after one, and at the end.
 *
 * After as well as before, because Cursor's own write tool does not always say what
 * it is about to change, and `afterFileEdit` always does: the lines are claimed the
 * moment they are written, so another machine reaching for them is still stopped.
 */
function withCursorHook(config: CursorHooks, command: string): CursorHooks {
  const cleared = withoutCursorHook(config);
  const hooks = { ...(cleared.hooks ?? {}) };
  const add = (event: string, entry: CursorHook): void => {
    hooks[event] = [...(hooks[event] ?? []), entry];
  };
  add(CURSOR_EVENT.PRE_TOOL_USE, { command, matcher: CURSOR_EDIT_TOOLS.join('|') });
  add(CURSOR_EVENT.AFTER_FILE_EDIT, { command });
  add(CURSOR_EVENT.SESSION_END, { command });
  /* After every tool call and at the end of every turn: where a note waiting for
     the conversation is handed over, and where what it did is written down. */
  add(CURSOR_EVENT.POST_TOOL_USE, { command });
  add(CURSOR_EVENT.STOP, { command });
  return { ...cleared, version: cleared.version ?? CURSOR_HOOKS_VERSION, hooks };
}

export async function installCursorHook(home: string): Promise<boolean> {
  const path = join(home, CURSOR_HOOKS);
  if (!existsSync(dirname(path))) return false;
  try {
    const raw = existsSync(path) ? await readFile(path, 'utf8') : '{}';
    const config = JSON.parse(raw) as CursorHooks;
    const next = withCursorHook(config, commandFor(DISCOVERED_AGENT_KIND.CURSOR));
    if (JSON.stringify(next) === JSON.stringify(config)) return true;
    if (existsSync(path)) await writeFile(`${path}.memnox-backup`, raw, 'utf8');
    await writeFile(path, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
    return true;
  } catch {
    // Not plain JSON: left alone, because writing it whole would drop what it held.
    return false;
  }
}

export async function removeCursorHook(home: string): Promise<boolean> {
  return removeJsonHooks(join(home, CURSOR_HOOKS));
}

/** Takes this hook's entries out of a Cursor- or Windsurf-shaped hooks file. */
async function removeJsonHooks(path: string): Promise<boolean> {
  if (!existsSync(path)) return false;
  try {
    const raw = await readFile(path, 'utf8');
    const config = JSON.parse(raw) as CursorHooks;
    const next = withoutCursorHook(config);
    if (JSON.stringify(next) === JSON.stringify(config)) return false;
    await writeFile(`${path}.memnox-backup`, raw, 'utf8');
    await writeFile(path, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
    return true;
  } catch {
    // Not plain JSON, or not ours to read: it is left exactly as it was.
    return false;
  }
}
