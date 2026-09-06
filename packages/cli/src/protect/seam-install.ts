import { existsSync, realpathSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { homedir, release } from 'node:os';
import { basename, dirname, join } from 'node:path';
import {
  guardFor,
  guardPlanFrom,
  landlockRuleset,
  loadPoliciesFromFile,
  OS_GUARD,
  seatbeltProfile,
  type GuardPolicy,
} from '@memnox/core';
import {
  installGitHooks,
  installInterceptors,
  INTERCEPT_BINARY,
  interceptorDirFor,
} from '@memnox/interceptors';
import type { CliContext } from '../cli-context';
import { guardProfilePath, landlockRulesetPath } from '../memnox-paths';
import {
  addToProfile,
  blockFor,
  pathLineFor,
  profilesFor,
  removeFromProfile,
} from './shell-profile';
import { resolvePolicyFile } from '../policy-path';

/**
 * PATH is the whole mechanism, and nothing here edits a shell profile on its own:
 * `memnox run` sets it for the agent it starts, and `protect --path` writes the line
 * only when somebody asks for it by name. A tool that silently rewrote your `.zshrc`
 * is one you would not trust twice.
 */
export async function runInterceptors(context: CliContext): Promise<void> {
  const home = homedir();
  const report = await installInterceptors(home, INTERCEPT_BINARY);
  const { out, style } = context;

  out.line(`Installed ${report.installed.length} interceptor(s) in ${report.directory}`);
  out.line(`  ${report.installed.join(', ')}`);
  /* Named rather than silently skipped: a rule written for a CLI this machine does not
     have is not broken, and somebody installing it later needs to know to re-run this. */
  if (report.absent.length > 0) {
    out.line('');
    out.line(
      `  ${style.dim(`not on this machine, so not wrapped: ${report.absent.join(', ')}`)}`,
    );
    out.line(`  ${style.dim('install one of those later and run this again')}`);
  }
  out.line('');
  out.line('They only bite when that directory comes first on PATH:');
  out.line(`  ${style.bold('memnox run -- <your agent>')}   sets it for that agent`);
  /* The second line is the only way to reach an editor opened from a dock icon: it
     takes its environment from the login shell, never from a process we start. */
  out.line(
    `  ${style.bold('memnox protect --path')}          writes it into your shell profile`,
  );
  out.line(`  ${style.dim(report.pathLine)}   or paste that yourself`);
  out.line('');
  out.note(
    `Undo with "memnox uninstall". Nothing outside ${interceptorDirFor(home)} was touched.`,
  );
}

/**
 * Defence in depth, and the only gate that still holds when somebody runs a binary
 * without the interceptor directory on PATH. A hook is a file in the repository's own
 * `.git`, so it is installed per repository and never machine-wide.
 */
export async function runHooks(context: CliContext, repoDir: string): Promise<void> {
  const { out, style } = context;
  const report = await installGitHooks(repoDir);

  if (report.installed.length === 0 && report.skipped.length === 0) {
    out.line(`No git repository at ${repoDir}, so there is nowhere to put a hook.`);
    return;
  }
  for (const hook of report.installed) out.line(`${style.ok('installed')}  ${hook}`);
  // A hook somebody else wrote is never overwritten; theirs is the one that matters.
  for (const hook of report.skipped) {
    out.line(`${style.warn('kept')}       ${hook} — yours, left alone`);
  }
  out.line('');
  out.line('A blocked push now stops even when the interceptors are not on PATH.');
  out.note('Undo with "memnox uninstall".');
}

/**
 * The kernel as a second line under the interceptors: a denied path stays unreadable
 * even to a binary that never saw a wrapper. What it cannot express is printed, because
 * a guard quietly covering less than the rules do is worse than no guard at all.
 */
export async function runOsGuard(
  context: CliContext,
  repoDir: string,
  /** Injected so a test can point it at a symlinked home, which is the whole bug. */
  home: string = homedir(),
): Promise<void> {
  const { out, style } = context;
  const support = guardFor(process.platform, release());

  const file = resolvePolicyFile();
  if (!existsSync(file)) {
    throw new Error(`No rules at ${file}. Write some first:  memnox protect --yes`);
  }
  const plan = guardPlanFrom(await loadPoliciesFromFile(file), home, [repoDir]);
  const denied = plan.policy.denyRead.length + plan.policy.denyWrite.length;
  if (denied === 0) {
    out.line('No filesystem rule denies a path, so there is nothing to hand the kernel.');
    return;
  }

  if (support.guard === OS_GUARD.SEATBELT) {
    const path = guardProfilePath(home);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(path, seatbeltProfile(throughSymlinks(plan.policy)), {
      encoding: 'utf8',
      mode: 0o600,
    });
    out.line(`Wrote a seatbelt profile covering ${denied} path(s) to ${path}`);
    out.line('');
    out.line(
      `  ${style.bold('memnox run -- <your agent>')}   starts it inside the sandbox`,
    );
  } else if (support.guard === OS_GUARD.LANDLOCK) {
    const ruleset = landlockRuleset(plan.policy);
    const path = landlockRulesetPath(home);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(path, `${JSON.stringify(ruleset, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    out.line(`Wrote a Landlock ruleset covering ${denied} path(s) to ${path}`);
  } else {
    out.line(`No kernel guard here: ${support.because}`);
    return;
  }

  for (const pattern of plan.skipped) {
    out.note(`the kernel cannot express "${pattern}" — the interceptors still cover it`);
  }
}

/**
 * The interceptor directory on the login PATH, so a windowed editor's integrated
 * terminal meets the wrappers too. Opt-in by name, fenced by markers, and removable.
 */
export async function runPathLine(
  context: CliContext,
  reverting: boolean,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const home = homedir();
  const shell = env['SHELL'] ?? 'zsh';
  const candidates = profilesFor(shell, home);
  const { out, style } = context;

  if (reverting) {
    let removed = 0;
    for (const path of candidates) {
      const edit = await removeFromProfile(path);
      if (edit.state === 'removed') {
        out.line(`Took our line back out of ${path}.`);
        removed += 1;
      }
    }
    if (removed === 0)
      out.line('No Memnox line in any profile here, so nothing changed.');
    else
      out.note('Open a new terminal, or restart your editor, for that to take effect.');
    return;
  }

  /* The first profile that already exists, so we add to the file the shell actually
     reads rather than creating a second one it will ignore. */
  const target = (await firstExisting(candidates)) ?? (candidates[0] as string);
  const edit = await addToProfile(target, blockFor(shell, home));

  if (edit.state === 'unchanged') {
    out.line(`${target} already has our line, so nothing changed.`);
    return;
  }
  out.line(`Added the interceptor directory to PATH in ${target}:`);
  out.line(`  ${style.dim(pathLineFor(shell, home))}`);
  out.line('');
  out.line('Open a new terminal, or restart your editor, for that to take effect.');
  out.note(
    'Undo with "memnox protect --revert-path". Nothing outside our markers is touched.',
  );
}

async function firstExisting(paths: readonly string[]): Promise<string | null> {
  for (const path of paths) if (existsSync(path)) return path;
  return null;
}

/**
 * The paths the kernel will actually see.
 *
 * Seatbelt matches on the resolved path, so a rule naming a symlinked one silently
 * matches nothing: on macOS `/tmp` is `/private/tmp`, and a profile written with
 * `(deny file-read* (subpath "/tmp/x/.ssh"))` let every read of that key straight
 * through while reporting that the sandbox was on. The same is true of any home
 * reached through a link.
 *
 * Both spellings are kept. Resolving is what makes the rule bite; keeping the
 * original costs one line and covers the case where the link is what gets opened.
 */
function throughSymlinks(policy: GuardPolicy): GuardPolicy {
  const both = (paths: readonly string[]): string[] => [
    ...new Set(paths.flatMap((path) => [path, resolveThrough(path)])),
  ];
  return {
    denyRead: both(policy.denyRead),
    denyWrite: both(policy.denyWrite),
    allowWrite: both(policy.allowWrite),
  };
}

/**
 * `realpath` on the longest part of the path that exists, with the rest put back.
 *
 * A denied path very often does not exist yet — that is half the point of denying it —
 * and `realpathSync` throws on those, so resolving only what is there is what makes
 * the rule cover the file when it appears.
 */
function resolveThrough(path: string): string {
  let head = path;
  const tail: string[] = [];
  while (head !== dirname(head)) {
    try {
      return join(realpathSync(head), ...tail);
    } catch {
      tail.unshift(basename(head));
      head = dirname(head);
    }
  }
  return path;
}
