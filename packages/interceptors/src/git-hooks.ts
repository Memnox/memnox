import { mkdir, readFile, rm, writeFile, chmod } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Defence in depth. An interceptor is bypassed by anything that calls the real binary
 * directly; a hook runs inside git itself, so a push that dodged PATH still meets a
 * rule. Slower and narrower than the interceptor, which is why it is the second line.
 */
export const HOOKS = ['pre-push', 'pre-commit'] as const;

export type GitHook = (typeof HOOKS)[number];

export const HOOK_MARKER = '# installed by memnox';

function bodyFor(hook: GitHook): string {
  const action = hook === 'pre-push' ? 'git.push' : 'git.commit';
  return [
    '#!/bin/sh',
    HOOK_MARKER,
    '# Remove this file, or run "memnox uninstall", to undo.',
    '',
    '# Non-zero stops the operation, which is the whole point of a hook.',
    `memnox policy test "${action}" >/dev/null 2>&1 || {`,
    `  memnox policy test "${action}" >&2`,
    '  exit 1',
    '}',
    'exit 0',
    '',
  ].join('\n');
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

export async function installGitHooks(repoDir: string): Promise<HookInstallReport> {
  const hooksDir = join(repoDir, '.git', 'hooks');
  await mkdir(hooksDir, { recursive: true });

  const report: HookInstallReport = { installed: [], skipped: [] };
  for (const hook of HOOKS) {
    const path = join(hooksDir, hook);
    const existing = await existingHook(path);
    if (existing !== null && !existing.includes(HOOK_MARKER)) {
      report.skipped.push({ hook, because: 'a hook is already there and is not ours' });
      continue;
    }
    await writeFile(path, bodyFor(hook), { encoding: 'utf8', mode: 0o755 });
    await chmod(path, 0o755);
    report.installed.push(hook);
  }
  return report;
}

/** Removes only hooks carrying our marker, so somebody else's survives. */
export async function removeGitHooks(repoDir: string): Promise<GitHook[]> {
  const hooksDir = join(repoDir, '.git', 'hooks');
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
