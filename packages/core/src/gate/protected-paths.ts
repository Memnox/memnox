/**
 * What governs an agent, as paths: Memnox's own home and rule files, and the Claude Code
 * settings that install its hooks. An agent that could write any of them could turn Memnox
 * off, answer its own questions, or take the hooks out, so these are a person's alone.
 */
import { realpathSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

/** Claude Code's settings, which hold the hooks and could switch every one of them off. */
const CLAUDE_SETTINGS = /(^|\/)\.claude\/settings(\.local)?\.json$|(^|\/)\.claude\.json$/;

/**
 * Every other file Memnox installs a hook into, as segments under a home directory. Shared
 * with the installer in the CLI on purpose: a file a hook is written into and not protected
 * here is a hook the agent can take back out.
 */
export const AGENT_HOOK_FILES: readonly (readonly string[])[] = [
  ['.codex', 'hooks.json'],
  ['.cursor', 'hooks.json'],
  ['.gemini', 'settings.json'],
  ['.codeium', 'windsurf', 'hooks.json'],
];

const HOOK_FILE_PATHS: readonly string[] = AGENT_HOOK_FILES.map((parts) =>
  parts.join('/'),
);

/** The binaries a hook runs by name, so replacing one would answer for Memnox. */
const MEMNOX_BINARY = /\/(bin|\.bin)\/memnox(-[\w-]+)?$/;

/** Whether a path, as written, names something that governs the agent. */
export function isProtectedPath(target: string): boolean {
  const path = target.replace(/\\/g, '/');
  if (
    path.includes('/.memnox/') ||
    path.endsWith('/.memnox') ||
    path.startsWith('.memnox/')
  )
    return true;
  const name = path.split('/').pop() ?? '';
  if (
    /^memnox\.policies\.(toml|ya?ml|json)$/.test(name) ||
    /\.policies\.toml$/.test(name)
  )
    return true;
  if (HOOK_FILE_PATHS.some((file) => path === file || path.endsWith(`/${file}`)))
    return true;
  return CLAUDE_SETTINGS.test(path) || MEMNOX_BINARY.test(path);
}

/**
 * Where a path really lands once every link on the way is followed, so a symlink into
 * `~/.memnox` is the protected path it points at. The part that does not exist yet is
 * joined back on, since a file about to be created has no real path of its own.
 */
export function realPathOf(target: string, cwd: string = process.cwd()): string {
  const absolute = resolve(cwd, target.replace(/^~(?=\/|$)/, homeOf()));
  let existing = absolute;
  const rest: string[] = [];
  for (;;) {
    try {
      return join(realpathSync.native(existing), ...rest.reverse());
    } catch {
      const parent = dirname(existing);
      // Nothing on the way exists, so nothing on the way can be a link.
      if (parent === existing) return absolute;
      rest.push(basename(existing));
      existing = parent;
    }
  }
}

function homeOf(): string {
  return process.env['HOME'] ?? '';
}

/** Whether a path, as written or where it really lands, names something that governs the agent. */
export function touchesProtected(target: string, cwd?: string): boolean {
  return isProtectedPath(target) || isProtectedPath(realPathOf(target, cwd));
}

/**
 * Text in a command line that names a protected place. Only the part a person would type:
 * a determined agent can spell it so no pattern finds it, which is what the kernel wall
 * around its shell is for; this catches the plain spelling before anything runs.
 */
const NAMES_PROTECTED = new RegExp(
  [
    '\\.memnox\\b',
    '\\.policies\\.toml\\b',
    '\\.claude\\/settings(\\.local)?\\.json',
    '\\.claude\\.json',
    // Built from the one list, so a hook file cannot be installed into and left unnamed here.
    ...HOOK_FILE_PATHS.map((file) => file.replace(/\./g, '\\.')),
    'disableAllHooks',
    'allowUnsandboxedCommands',
  ].join('|'),
);

export function namesProtected(line: string): string | null {
  return NAMES_PROTECTED.exec(line)?.[0] ?? null;
}
