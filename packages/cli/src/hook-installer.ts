import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { HOOK_EVENT_NAME, TOOL_ACTIONS } from '@memnox/tool-hook';

/**
 * The entry is marked by its own status message rather than by its path: an upgrade
 * moves the binary, and identifying our hook by where it happens to live today is how
 * uninstall starts missing it.
 */
export const MEMNOX_HOOK_MARKER = 'Memnox is ruling on this action';

/** Seconds. A gate on every tool call cannot be allowed to hang the agent. */
export const HOOK_TIMEOUT_SECONDS = 10;

/** Built from the map itself, so the matcher and the actions cannot drift apart. */
export const HOOK_MATCHER = Object.keys(TOOL_ACTIONS).join('|');

interface HookInstallReport {
  path: string;
  /** False when an identical entry was already there — re-running changes nothing. */
  installed: boolean;
  command: string;
}

/**
 * An absolute path, because a GUI-launched agent inherits no PATH and a relative
 * command would silently never run. Resolved at install time and never at construction:
 * building the command tree must not depend on this package having been built.
 */
function resolveHookCommand(): string {
  const require = createRequire(import.meta.url);
  try {
    return `${quote(process.execPath)} ${quote(require.resolve('@memnox/tool-hook/cli'))}`;
  } catch (err) {
    throw new Error(
      `could not locate the Memnox tool hook — run "npm run build" in the runtime, or reinstall memnox (${String(err)})`,
      { cause: err },
    );
  }
}

function quote(path: string): string {
  return path.includes(' ') ? `"${path}"` : path;
}

/**
 * User-level, never project-level: a committed hook config would run a binary a
 * teammate never installed. Entries that are not ours are carried through untouched,
 * exactly as they were written — this file belongs to the reader, not to us.
 */
export class HookInstaller {
  constructor(
    private readonly homeDir: string,
    /** Injected by tests; resolved on the first install everywhere else. */
    private readonly command?: string,
  ) {}

  get settingsPath(): string {
    return join(this.homeDir, '.claude', 'settings.json');
  }

  async install(): Promise<HookInstallReport> {
    const command = this.command ?? resolveHookCommand();
    const path = this.settingsPath;
    const settings = await readJson(path);
    const hooks = asRecord(settings['hooks']);
    const entries = asArray(hooks[HOOK_EVENT_NAME]);

    const ours = entries.filter(isOurs);
    if (ours.length === 1 && isCurrent(ours[0], command)) {
      return { path, installed: false, command };
    }

    // Everything of ours goes, then one entry comes back: an upgrade repoints the
    // command, and a half-written earlier install cannot leave two gates behind.
    const kept = entries.filter((entry) => !isOurs(entry));
    kept.push(this.entry(command));

    hooks[HOOK_EVENT_NAME] = kept;
    settings['hooks'] = hooks;
    await writeJson(path, settings);
    return { path, installed: true, command };
  }

  async uninstall(): Promise<boolean> {
    const path = this.settingsPath;
    const settings = await readJson(path);
    const hooks = asRecord(settings['hooks']);
    const entries = asArray(hooks[HOOK_EVENT_NAME]);

    const kept = entries.filter((entry) => !isOurs(entry));
    if (kept.length === entries.length) return false;

    // An empty array left behind reads as a configured-but-empty gate; remove the key.
    if (kept.length === 0) delete hooks[HOOK_EVENT_NAME];
    else hooks[HOOK_EVENT_NAME] = kept;

    if (Object.keys(hooks).length === 0) delete settings['hooks'];
    else settings['hooks'] = hooks;

    await writeJson(path, settings);
    return true;
  }

  /** What is installed right now, so `status` reads the file rather than assuming. */
  async installedCommand(): Promise<string | null> {
    const settings = await readJson(this.settingsPath);
    const entries = asArray(asRecord(settings['hooks'])[HOOK_EVENT_NAME]);
    for (const entry of entries) {
      const handler = ourHandler(entry);
      if (handler !== null) return readText(handler, 'command');
    }
    return null;
  }

  private entry(command: string): Record<string, unknown> {
    return {
      matcher: HOOK_MATCHER,
      hooks: [
        {
          type: 'command',
          command,
          timeout: HOOK_TIMEOUT_SECONDS,
          statusMessage: MEMNOX_HOOK_MARKER,
        },
      ],
    };
  }
}

/** Ours when one of its handlers carries our marker; read-only, nothing is reshaped. */
function ourHandler(entry: unknown): Record<string, unknown> | null {
  const record = asRecordOrNull(entry);
  if (record === null) return null;
  for (const raw of asArray(record['hooks'])) {
    const handler = asRecordOrNull(raw);
    if (handler === null) continue;
    if (readText(handler, 'statusMessage') === MEMNOX_HOOK_MARKER) return handler;
  }
  return null;
}

function isOurs(entry: unknown): boolean {
  return ourHandler(entry) !== null;
}

function isCurrent(entry: unknown, command: string): boolean {
  const record = asRecordOrNull(entry);
  if (record === null) return false;
  if (readText(record, 'matcher') !== HOOK_MATCHER) return false;
  const handler = ourHandler(entry);
  if (handler === null) return false;
  return readText(handler, 'command') === command;
}

function readText(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === 'string' ? value : '';
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? [...value] : [];
}

function asRecordOrNull(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asRecord(value: unknown): Record<string, unknown> {
  const record = asRecordOrNull(value);
  return record === null ? {} : record;
}

async function readJson(path: string): Promise<Record<string, unknown>> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
  } catch {
    return {}; // First install, or settings this agent has not written yet.
  }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}
