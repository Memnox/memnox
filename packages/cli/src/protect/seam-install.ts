import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { homedir, release } from 'node:os';
import { dirname } from 'node:path';
import {
  guardFor,
  guardPlanFrom,
  landlockRuleset,
  loadPoliciesFromFile,
  OS_GUARD,
  seatbeltProfile,
} from '@memnox/core';
import {
  installGitHooks,
  installInterceptors,
  interceptorDirFor,
} from '@memnox/interceptors';
import type { CliContext } from '../cli-context';
import { guardProfilePath, landlockRulesetPath } from '../memnox-paths';
import { resolvePolicyFile } from '../policy-path';

/** The binary every wrapper execs. Shipped by the CLI package, so it is beside us. */
const INTERCEPT_BINARY = 'memnox-intercept';

/**
 * PATH is the whole mechanism, and we deliberately do not edit anybody's shell
 * profile: the directory is printed and `memnox run` sets it for the agent it starts.
 * A tool that silently rewrote your `.zshrc` is one you would not trust twice.
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
  out.line(`  ${style.dim(report.pathLine)}   sets it for your shell, if you want that`);
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
export async function runOsGuard(context: CliContext, repoDir: string): Promise<void> {
  const { out, style } = context;
  const home = homedir();
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
    await writeFile(path, seatbeltProfile(plan.policy), {
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
