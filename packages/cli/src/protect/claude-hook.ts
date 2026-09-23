import { existsSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AGENT_FLAG, DISCOVERED_AGENT_KIND } from '@memnox/core';
import {
  EDIT_HOOK_BINARY,
  EDIT_HOOK_EVENT,
  EDIT_TOOLS,
  TOOL_POLICY_FLAG,
} from '@memnox/interceptors';
import type { CliContext } from '../cli-context';
import { onPath } from '../on-path';
import { isInPlace, REWRITE, rewriteJsonFile, writeBackedUp } from './json-config';
import { markHook } from '../keeper/kept';

/**
 * Claude Code's own settings, with the lease hook in them or taken back out. Only the
 * entries this wrote are removed, found by the binary they run.
 */

export const CLAUDE_SETTINGS = join('.claude', 'settings.json');

/** Only the file tools, for an install that takes leases and rules on nothing. */
const MATCHER = EDIT_TOOLS.join('|');

/** Every tool, before it runs and after it returns, since a read is ruled on too. */
export const EVERY_TOOL = '*';

interface HookCommand {
  type: string;
  command: string;
}

interface HookEntry {
  matcher?: string;
  hooks?: HookCommand[];
}

type Settings = Record<string, unknown> & {
  hooks?: Record<string, HookEntry[]>;
};

/** One event the hook runs on, and which tools it runs for where the event names tools. */
export interface HookEvent {
  event: string;
  matcher?: string;
}

/**
 * Before a write, to take the lines; after a tool call, a turn or a prompt, where a
 * session can be handed a note; and when the session starts and ends.
 */
export function claudeEvents(editMatcher: string = MATCHER): HookEvent[] {
  return [
    { event: EDIT_HOOK_EVENT.PRE_TOOL_USE, matcher: editMatcher },
    { event: EDIT_HOOK_EVENT.SESSION_END },
    { event: EDIT_HOOK_EVENT.POST_TOOL_USE, matcher: EVERY_TOOL },
    { event: EDIT_HOOK_EVENT.STOP },
    { event: EDIT_HOOK_EVENT.USER_PROMPT_SUBMIT },
    // Where the session is told its boundary once, as added context.
    { event: EDIT_HOOK_EVENT.SESSION_START },
  ];
}

/**
 * The settings with the hook added on each event, and adding it twice changes nothing.
 * Codex and Gemini CLI read the same shape, so each passes its own events.
 */
export function withEditHook(
  settings: Settings,
  command: string,
  events: readonly HookEvent[] = claudeEvents(),
): Settings {
  const cleared = withoutEditHook(settings);
  const hooks = { ...(cleared.hooks ?? {}) };
  for (const each of events) {
    hooks[each.event] = [
      ...(hooks[each.event] ?? []),
      {
        ...(each.matcher === undefined ? {} : { matcher: each.matcher }),
        hooks: [{ type: 'command', command }],
      },
    ];
  }
  return { ...cleared, hooks };
}

/** The settings with every entry this wrote taken out, and nothing else. */
export function withoutEditHook(settings: Settings): Settings {
  const hooks = settings.hooks;
  if (hooks === undefined || typeof hooks !== 'object') return settings;
  const kept: Record<string, HookEntry[]> = {};
  for (const [event, entries] of Object.entries(hooks)) {
    if (!Array.isArray(entries)) {
      kept[event] = entries;
      continue;
    }
    const remaining = entries
      .map((entry) => ({
        ...entry,
        hooks: (entry.hooks ?? []).filter((each) => !isOurs(each)),
      }))
      .filter((entry) => entry.hooks.length > 0);
    if (remaining.length > 0) kept[event] = remaining;
  }
  const { hooks: _dropped, ...rest } = settings;
  return Object.keys(kept).length === 0 ? rest : { ...rest, hooks: kept };
}

/**
 * The bare binary only where it is on PATH, otherwise the path beside this one, because
 * a hook whose command is not found fails every write silently.
 */
export function editHookCommand(
  path: string | undefined = process.env['PATH'],
  exists: (file: string) => boolean = existsSync,
  sibling: string = fileURLToPath(new URL('./bin/edit-hook.js', import.meta.url)),
): string {
  if (onPath(EDIT_HOOK_BINARY, path ?? '', exists) || !exists(sibling)) {
    return EDIT_HOOK_BINARY;
  }
  return `"${process.execPath}" "${sibling}" --${EDIT_HOOK_BINARY}`;
}

/** The hook that takes leases and also rules on every tool call against the rules in force. */
function policyHookCommand(): string {
  return `${editHookCommand()} ${TOOL_POLICY_FLAG}`;
}

/** The policy hook naming the agent it runs for, so no action it rules on is anonymous. */
export function namedHookCommand(agent: string): string {
  return `${policyHookCommand()} ${AGENT_FLAG} ${agent}`;
}

/** Claude Code's, named by the kind its census row carries, like every other host's. */
function claudeHookCommand(): string {
  return namedHookCommand(DISCOVERED_AGENT_KIND.CLAUDE_CODE);
}

/**
 * Whether a hooks file holds our hook in its current shape, not only the lease half,
 * and naming its agent where one is given, so an install from before the flag is upgraded.
 */
export function holdsPolicyHook(text: string, agent?: string): boolean {
  const named = agent === undefined || text.includes(`${AGENT_FLAG} ${agent}`);
  return text.includes(EDIT_HOOK_BINARY) && text.includes(TOOL_POLICY_FLAG) && named;
}

function isOurs(hook: HookCommand): boolean {
  return typeof hook.command === 'string' && hook.command.includes(EDIT_HOOK_BINARY);
}

/**
 * Writes the hook into Claude Code's settings, or takes it back out. Machine-wide,
 * because the hook works out which repository a write lands in.
 */
export async function runClaudeHook(
  context: CliContext,
  reverting: boolean,
  home: () => string = homedir,
): Promise<void> {
  const path = join(home(), CLAUDE_SETTINGS);
  const raw = existsSync(path) ? await readFile(path, 'utf8') : '{}';
  const settings = parseSettings(path, raw);

  await mkdir(dirname(path), { recursive: true });
  const next = reverting
    ? withoutEditHook(settings)
    : withEditHook(settings, claudeHookCommand(), claudeEvents(EVERY_TOOL));
  await writeBackedUp(path, raw, next);
  // A hook taken out on purpose stays out, rather than coming back on the daemon's next pass.
  await markHook(home(), 'Claude Code', !reverting);
  renderClaudeHook(context, path, reverting);
}

function parseSettings(path: string, raw: string): Settings {
  try {
    // Somebody else's file: only `hooks` is read, and everything else is copied through.
    return JSON.parse(raw) as Settings;
  } catch {
    throw new Error(
      `${path} is not plain JSON, so it was left alone. Add a PreToolUse hook running "${claudeHookCommand()}" for every tool yourself.`,
    );
  }
}

function renderClaudeHook(context: CliContext, path: string, reverting: boolean): void {
  const { flow } = context;
  flow.rows(reverting ? 'Removed' : 'Installed', [
    { label: 'where', value: path },
    { label: 'runs', value: `${EDIT_HOOK_BINARY} before every tool call` },
  ]);
  if (reverting) {
    flow.close(
      'Claude Code no longer checks your rules or takes a lease from its own tools.',
    );
    return;
  }
  flow.close(
    'Claude Code now checks every tool call against your rules and takes a lease before it writes a file.',
  );
  flow.hint('Two sessions on one file: the second waits, then is told who holds it.');
  flow.hint('Enrolled with "memnox login", the lease is shared with every machine.');
  flow.hint('Undo with "memnox protect --revert-claude-hook".');
}

/**
 * For the wiring `setup` does, only where `~/.claude` exists, since creating it would
 * assume an editor nobody has. True when the hook is in place.
 */
export async function installClaudeHook(home: string): Promise<boolean> {
  return installSettingsHook(
    join(home, CLAUDE_SETTINGS),
    claudeHookCommand(),
    claudeEvents(EVERY_TOOL),
  );
}

/**
 * The same hook written into a settings file shaped like Claude Code's, only where its
 * directory exists. Quiet on a file it cannot read, and true when the hook is in place.
 */
export async function installSettingsHook(
  path: string,
  command: string,
  events: readonly HookEvent[],
): Promise<boolean> {
  const outcome = await rewriteJsonFile<Settings>(path, (settings) =>
    withEditHook(settings, command, events),
  );
  return isInPlace(outcome);
}

/**
 * Takes the hook out, where it was ever put in. Quiet on anything it cannot read,
 * because an uninstall must not stop over somebody's editor settings.
 */
export async function removeClaudeHook(home: string): Promise<boolean> {
  return removeSettingsHook(join(home, CLAUDE_SETTINGS));
}

/** Takes the hook back out of a settings file shaped like Claude Code's. */
export async function removeSettingsHook(path: string): Promise<boolean> {
  return (await rewriteJsonFile(path, withoutEditHook)) === REWRITE.WRITTEN;
}
