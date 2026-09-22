import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EDIT_HOOK_BINARY, EDIT_HOOK_EVENT, EDIT_TOOLS } from '@memnox/interceptors';
import type { CliContext } from '../cli-context';

/**
 * Claude Code's own settings, with the lease hook in them or taken back out.
 *
 * The file is somebody's editor configuration, so three rules hold. It is backed up
 * before it is touched. Only the entries this wrote are ever removed, found by the
 * binary they run, so a hook somebody wrote themselves survives both directions.
 * And a file that is not plain JSON is left alone, because writing it whole would
 * drop whatever could not be understood.
 */

const CLAUDE_SETTINGS = join('.claude', 'settings.json');

/** Only the file tools, so a read never so much as starts this process before it runs. */
const MATCHER = EDIT_TOOLS.join('|');

/** Every tool, for the moment after one returns. */
const EVERY_TOOL = '*';

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
 * Claude Code's events. Before a write, to take the lines; after every tool call,
 * at the end of a turn and when the person asks for something, which are the
 * moments a session can be handed a note; and when the session ends.
 */
export function claudeEvents(editMatcher: string = MATCHER): HookEvent[] {
  return [
    { event: EDIT_HOOK_EVENT.PRE_TOOL_USE, matcher: editMatcher },
    { event: EDIT_HOOK_EVENT.SESSION_END },
    { event: EDIT_HOOK_EVENT.POST_TOOL_USE, matcher: EVERY_TOOL },
    { event: EDIT_HOOK_EVENT.STOP },
    { event: EDIT_HOOK_EVENT.USER_PROMPT_SUBMIT },
  ];
}

/**
 * The settings with the hook added on each event. Adding it twice changes nothing.
 *
 * Claude Code, Codex and Gemini CLI all read hooks of this shape and differ only
 * in their event and tool names, so each passes its own list.
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
 * What the settings should run, which is the bare binary only where it is on
 * PATH.
 *
 * A hook whose command is not found fails on every write and says so in a way
 * the editor shows and nobody reads, so the lease would silently not be taken.
 * Run from a checkout rather than a global install, the binary sits beside this
 * one and is named by its path. The name rides as a trailing argument so the
 * entry is still found as ours when it is taken back out.
 */
export function editHookCommand(
  path: string | undefined = process.env['PATH'],
  exists: (file: string) => boolean = existsSync,
  sibling: string = fileURLToPath(new URL('./bin/edit-hook.js', import.meta.url)),
): string {
  const onPath = (path ?? '')
    .split(delimiter)
    .some((dir) => dir !== '' && exists(join(dir, EDIT_HOOK_BINARY)));
  if (onPath || !exists(sibling)) return EDIT_HOOK_BINARY;
  return `"${process.execPath}" "${sibling}" --${EDIT_HOOK_BINARY}`;
}

function isOurs(hook: HookCommand): boolean {
  return typeof hook.command === 'string' && hook.command.includes(EDIT_HOOK_BINARY);
}

/**
 * Writes the hook into Claude Code's settings, or takes it back out.
 *
 * Machine-wide rather than per repository, because a lease is keyed on the
 * repository the write lands in and the hook works that out for itself: a session
 * outside any repository takes nothing and waits on nothing.
 */
export async function runClaudeHook(
  context: CliContext,
  reverting: boolean,
  home: () => string = homedir,
): Promise<void> {
  const { flow } = context;
  const path = join(home(), CLAUDE_SETTINGS);
  const raw = existsSync(path) ? await readFile(path, 'utf8') : '{}';

  let settings: Settings;
  try {
    settings = JSON.parse(raw) as Settings;
  } catch {
    throw new Error(
      `${path} is not plain JSON, so it was left alone. Add a PreToolUse hook running "${EDIT_HOOK_BINARY}" for ${MATCHER} yourself.`,
    );
  }

  if (existsSync(path)) await writeFile(`${path}.memnox-backup`, raw, 'utf8');
  await mkdir(dirname(path), { recursive: true });
  const next = reverting
    ? withoutEditHook(settings)
    : withEditHook(settings, editHookCommand());
  await writeFile(path, `${JSON.stringify(next, null, 2)}\n`, 'utf8');

  flow.rows(reverting ? 'Removed' : 'Installed', [
    { label: 'where', value: path },
    { label: 'runs', value: `${EDIT_HOOK_BINARY} before ${MATCHER}` },
  ]);
  if (reverting) {
    flow.close('Claude Code no longer takes a lease before it writes a file.');
    return;
  }
  flow.close(
    'Claude Code now takes a lease before it writes a file, and lets go when the session ends.',
  );
  flow.hint('Two sessions on one file: the second waits, then is told who holds it.');
  flow.hint('Enrolled with "memnox login", the lease is shared with every machine.');
  flow.hint('Undo with "memnox protect --revert-claude-hook".');
}

/**
 * Puts the hook in where Claude Code is installed, for the wiring `setup` does.
 *
 * Only where `~/.claude` already exists: creating it would be this command deciding
 * somebody uses an editor they do not have. Quiet on a file it cannot read, for the
 * same reason an uninstall is. True when the hook is now in place.
 */
export async function installClaudeHook(home: string): Promise<boolean> {
  return installSettingsHook(
    join(home, CLAUDE_SETTINGS),
    editHookCommand(),
    claudeEvents(),
  );
}

/**
 * The same hook written into a settings file shaped like Claude Code's.
 *
 * Only where the file's directory already exists, which is where the agent is
 * installed. Quiet on a file it cannot read. True when the hook is now in place.
 */
export async function installSettingsHook(
  path: string,
  command: string,
  events: readonly HookEvent[],
): Promise<boolean> {
  if (!existsSync(dirname(path))) return false;
  try {
    const raw = existsSync(path) ? await readFile(path, 'utf8') : '{}';
    const settings = JSON.parse(raw) as Settings;
    const next = withEditHook(settings, command, events);
    if (JSON.stringify(next) === JSON.stringify(settings)) return true;
    if (existsSync(path)) await writeFile(`${path}.memnox-backup`, raw, 'utf8');
    await writeFile(path, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
    return true;
  } catch {
    // Not plain JSON: left alone, and `protect --claude-hook` says how to add it.
    return false;
  }
}

/**
 * Takes the hook out, where it was ever put in. Quiet on anything it cannot read,
 * because an uninstall must not stop over somebody's editor settings. True when it
 * removed something.
 */
export async function removeClaudeHook(home: string): Promise<boolean> {
  return removeSettingsHook(join(home, CLAUDE_SETTINGS));
}

/** Takes the hook back out of a settings file shaped like Claude Code's. */
export async function removeSettingsHook(path: string): Promise<boolean> {
  if (!existsSync(path)) return false;
  try {
    const raw = await readFile(path, 'utf8');
    const settings = JSON.parse(raw) as Settings;
    const next = withoutEditHook(settings);
    if (JSON.stringify(next) === JSON.stringify(settings)) return false;
    await writeFile(`${path}.memnox-backup`, raw, 'utf8');
    await writeFile(path, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
    return true;
  } catch {
    // Not plain JSON, or not ours to read: it is left exactly as it was.
    return false;
  }
}
