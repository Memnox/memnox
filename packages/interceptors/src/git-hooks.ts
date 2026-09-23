import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { ACTION } from '@memnox/core';

/**
 * Defence in depth. An interceptor is bypassed by anything that calls the real binary
 * directly; a hook runs inside git itself, so a push that dodged PATH still meets a rule.
 */

export const HOOKS = ['pre-push', 'pre-commit'] as const;

export type GitHook = (typeof HOOKS)[number];

export const HOOK_MARKER = '# installed by memnox';

/** Runnable by git, which executes a hook directly. */
const HOOK_MODE = 0o755;

/**
 * The actions each hook rules on. `pre-push` asks about a force push rather than
 * `git.push`, since the baseline denies one and allows an ordinary push.
 */
const HOOK_ACTIONS: Readonly<Record<GitHook, string>> = {
  'pre-push': ACTION.GIT_PUSH_FORCE,
  'pre-commit': ACTION.GIT_COMMIT,
};

/** Lets anything but a force push through before Memnox is asked. */
const FORCE_PUSH_ONLY: readonly string[] = [
  '# Only a force push. git names no flag, so it is read off the refs it is given:',
  '# a remote tip that is not an ancestor of the local one is history being rewritten.',
  'forced=0',
  'while read -r _local_ref local_sha _remote_ref remote_sha; do',
  '  [ -z "$remote_sha" ] && continue',
  '  case "$remote_sha" in *[!0]*) ;; *) continue ;; esac',
  '  git merge-base --is-ancestor "$remote_sha" "$local_sha" 2>/dev/null || forced=1',
  'done',
  '[ "$forced" = "0" ] && exit 0',
  '',
];

function bodyFor(hook: GitHook, binary: string): string {
  return [
    '#!/bin/sh',
    HOOK_MARKER,
    '# Remove this file, or run "memnox uninstall", to undo.',
    '',
    `MEMNOX="${binary}"`,
    'command -v "$MEMNOX" >/dev/null 2>&1 || MEMNOX=memnox',
    '',
    ...(hook === 'pre-push' ? FORCE_PUSH_ONLY : []),
    ...verdictLines(HOOK_ACTIONS[hook]),
  ].join('\n');
}

function verdictLines(action: string): string[] {
  return [
    `"$MEMNOX" policy test "${action}" >/dev/null 2>&1`,
    'status=$?',
    '[ "$status" = "0" ] && exit 0',
    '',
    '# 126 and 127 are the shell saying it never ran: not found, or found and not',
    '# runnable because its interpreter is missing. A hook that ruled on nothing must',
    '# not block, or installing Memnox and then opening a shell without it on PATH,',
    '# which is every shell after "npx memnox", would stop every commit in the repo.',
    'if [ "$status" = "127" ] || [ "$status" = "126" ]; then',
    '  echo "memnox: could not run here, so this hook ruled on nothing" >&2',
    '  exit 0',
    'fi',
    '',
    '# Non-zero from Memnox itself stops the operation, which is the point of a hook.',
    `"$MEMNOX" policy test "${action}" >&2`,
    'exit 1',
    '',
  ];
}

function hooksDirOf(repoDir: string): string {
  return join(repoDir, '.git', 'hooks');
}

/** The `memnox` this process is, when it can be worked out; the bare name otherwise. */
function defaultBinary(): string {
  const [, script] = process.argv;
  return script === undefined || script === '' ? 'memnox' : script;
}

export interface HookInstallReport {
  installed: GitHook[];
  /** Hooks somebody else wrote. Never overwritten; named so a person decides. */
  skipped: { hook: GitHook; because: string }[];
}

async function existingHook(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    // No hook there yet, which is the ordinary case.
    return null;
  }
}

/**
 * Written with the path Memnox was run from, so the
 * hook works in a shell that never heard of it.
 */
export async function installGitHooks(
  repoDir: string,
  binary: string = defaultBinary(),
): Promise<HookInstallReport> {
  const hooksDir = hooksDirOf(repoDir);
  await mkdir(hooksDir, { recursive: true });

  const report: HookInstallReport = { installed: [], skipped: [] };
  for (const hook of HOOKS) {
    const path = join(hooksDir, hook);
    const existing = await existingHook(path);
    if (existing !== null && !existing.includes(HOOK_MARKER)) {
      report.skipped.push({ hook, because: 'a hook is already there and is not ours' });
      continue;
    }
    await writeFile(path, bodyFor(hook, binary), { encoding: 'utf8', mode: HOOK_MODE });
    await chmod(path, HOOK_MODE);
    report.installed.push(hook);
  }
  return report;
}

/** Removes only hooks carrying our marker, so somebody else's survives. */
export async function removeGitHooks(repoDir: string): Promise<GitHook[]> {
  const hooksDir = hooksDirOf(repoDir);
  const removed: GitHook[] = [];
  for (const hook of HOOKS) {
    const path = join(hooksDir, hook);
    const existing = await existingHook(path);
    if (existing === null || !existing.includes(HOOK_MARKER)) continue;
    await rm(path, { force: true });
    removed.push(hook);
  }
  return removed;
}
