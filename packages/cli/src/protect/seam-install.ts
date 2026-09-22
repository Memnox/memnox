import { existsSync, realpathSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { homedir, release } from 'node:os';
import { basename, dirname, join } from 'node:path';
import {
  guardFor,
  guardPlanFrom,
  landlockPlanFromPolicy,
  loadPoliciesFromFile,
  OS_GUARD,
  seatbeltProfile,
  type GuardPolicy,
  type Policy,
} from '@memnox/core';
import {
  installGitHooks,
  installInterceptors,
  INTERCEPT_BINARY,
  interceptorDirFor,
} from '@memnox/interceptors';
import type { CliContext } from '../cli-context';
import { TONE } from '../flow';
import { listDirectory } from '../landlock';
import { guardProfilePath, landlockRulesetPath } from '../memnox-paths';
import { resolvePolicyFile } from '../policy-path';
import { jsonText } from './json-config';
import {
  DEFAULT_SHELL,
  PROFILE_STATE,
  addToProfile,
  blockFor,
  pathLineFor,
  profilesFor,
  removeFromProfile,
} from './shell-profile';

/**
 * Installing the seams under the rules: PATH interceptors, git hooks, the kernel guard,
 * and the login PATH line. Nothing here edits a shell profile unless asked by name.
 */

const OWNER_ONLY_DIR = 0o700;
const OWNER_ONLY_FILE = 0o600;

/** PATH is the whole mechanism: `memnox run` sets it, and `protect --path` writes it. */
export async function runInterceptors(context: CliContext): Promise<void> {
  const home = homedir();
  const report = await installInterceptors(home, INTERCEPT_BINARY);
  const { flow } = context;

  flow.rows('Installed', [
    { label: 'where', value: report.directory },
    { label: 'wrapped', value: report.installed.join(', ') },
    // Named rather than skipped, so somebody installing that CLI later knows to re-run this.
    ...(report.absent.length === 0
      ? []
      : [
          {
            label: 'not here',
            value: `${report.absent.join(', ')}, so install one later and run this again`,
          },
        ]),
  ]);
  flow.close(`${report.installed.length} interceptor(s) installed.`);
  flow.hint('They only bite when that directory comes first on PATH:');
  flow.hint('memnox run -- <your agent>   sets it for that agent');
  // The only way to reach an editor opened from a dock icon, which takes its login shell's PATH.
  flow.hint('memnox protect --path        writes it into your shell profile');
  flow.hint(`${report.pathLine}   or paste that yourself`);
  flow.hint(
    `Undo with "memnox uninstall". Nothing outside ${interceptorDirFor(home)} was touched.`,
  );
}

/**
 * Defence in depth, and the only gate that still holds when somebody runs a binary
 * without the interceptor directory on PATH. A hook is a file in the repository's own
 * `.git`, so it is installed per repository and never machine-wide.
 */
export async function runHooks(context: CliContext, repoDir: string): Promise<void> {
  const { flow } = context;
  const report = await installGitHooks(repoDir);

  if (report.installed.length === 0 && report.skipped.length === 0) {
    flow.close(`No git repository at ${repoDir}, so there is nowhere to put a hook.`);
    return;
  }
  flow.list('Git hooks', [
    ...report.installed.map((hook) => ({ tone: TONE.OK, text: `installed  ${hook}` })),
    // A hook somebody else wrote is never overwritten; theirs is the one that matters.
    ...report.skipped.map((hook) => ({
      tone: TONE.DIM,
      text: `kept  ${hook}, because it is yours`,
    })),
  ]);
  flow.close(`${report.installed.length} hook(s) installed in ${repoDir}.`);
  flow.hint('A blocked push now stops even when the interceptors are not on PATH.');
  flow.hint('Undo with "memnox uninstall".');
}

/**
 * The kernel as a second line under the interceptors: a denied path stays unreadable
 * even to a binary that never saw a wrapper.
 */
export async function runOsGuard(
  context: CliContext,
  repoDir: string,
  /** Injected so a test can point it at a symlinked home, which is the whole bug. */
  home: string = homedir(),
): Promise<void> {
  const { flow } = context;
  const support = guardFor(process.platform, release());
  const plan = guardPlanFrom(await loadGuardRules(), home, [repoDir]);
  const denied = plan.policy.denyRead.length + plan.policy.denyWrite.length;
  if (denied === 0) {
    flow.close(
      'No filesystem rule denies a path, so there is nothing to hand the kernel.',
    );
    return;
  }
  const path = await writeGuard(support.guard, plan.policy, home);
  if (path === null) {
    flow.close(`No kernel guard here: ${support.because}`);
    return;
  }
  flow.rows('Written', [
    { label: 'guard', value: support.guard },
    { label: 'file', value: path },
    { label: 'covers', value: `${denied} path(s)` },
    // Printed, because a guard quietly covering less than the rules do is worse than none.
    ...plan.skipped.map((pattern) => ({
      label: 'cannot express',
      value: `"${pattern}", so the interceptors still cover it`,
    })),
  ]);
  flow.close(`A ${support.guard} guard covers ${denied} path(s).`);
  if (support.guard !== OS_GUARD.NONE) {
    flow.hint('memnox run -- <your agent>   starts it inside the sandbox');
  }
}

async function loadGuardRules(): Promise<Policy[]> {
  const file = resolvePolicyFile();
  if (!existsSync(file)) {
    throw new Error(`No rules at ${file}. Write some first:  memnox protect --yes`);
  }
  return loadPoliciesFromFile(file);
}

/** The guard file this platform reads, or null where it has no kernel guard. */
async function writeGuard(
  guard: string,
  policy: GuardPolicy,
  home: string,
): Promise<string | null> {
  if (guard === OS_GUARD.SEATBELT) {
    const path = guardProfilePath(home);
    await writeOwnerOnly(path, seatbeltProfile(throughSymlinks(policy)));
    return path;
  }
  if (guard === OS_GUARD.LANDLOCK) {
    const path = landlockRulesetPath(home);
    // The plan `memnox run` hands the helper: every grant spelled out, since Landlock only grants.
    await writeOwnerOnly(
      path,
      jsonText(landlockPlanFromPolicy(throughSymlinks(policy), listDirectory)),
    );
    return path;
  }
  return null;
}

async function writeOwnerOnly(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: OWNER_ONLY_DIR });
  await writeFile(path, text, { encoding: 'utf8', mode: OWNER_ONLY_FILE });
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
  const shell = env['SHELL'] ?? DEFAULT_SHELL;
  if (reverting) return removePathLine(context, profilesFor(shell, home));
  return addPathLine(context, shell, home);
}

async function removePathLine(
  context: CliContext,
  candidates: readonly string[],
): Promise<void> {
  const { flow } = context;
  const removed: string[] = [];
  for (const path of candidates) {
    const edit = await removeFromProfile(path);
    if (edit.state === PROFILE_STATE.REMOVED) removed.push(path);
  }
  if (removed.length === 0) {
    flow.close('No Memnox line in any profile here, so nothing changed.');
    return;
  }
  flow.list(
    'Taken back out',
    removed.map((path) => ({ tone: TONE.OK, text: path })),
  );
  flow.close(`Removed our line from ${removed.length} profile(s).`);
  flow.hint('Open a new terminal, or restart your editor, for that to take effect.');
}

async function addPathLine(
  context: CliContext,
  shell: string,
  home: string,
): Promise<void> {
  const { flow } = context;
  const candidates = profilesFor(shell, home);
  // The first profile that exists is the one the shell reads, rather than a second it ignores.
  // profilesFor always returns at least one path.
  const target = (await firstExisting(candidates)) ?? (candidates[0] as string);
  const edit = await addToProfile(target, blockFor(shell, home));

  if (edit.state === PROFILE_STATE.UNCHANGED) {
    flow.close(`${target} already has our line, so nothing changed.`);
    return;
  }
  flow.rows('Added to PATH', [
    { label: 'profile', value: target },
    { label: 'line', value: pathLineFor(shell, home) },
  ]);
  flow.close('Open a new terminal, or restart your editor, for that to take effect.');
  flow.hint(
    'Undo with "memnox protect --revert-path". Nothing outside our markers is touched.',
  );
}

async function firstExisting(paths: readonly string[]): Promise<string | null> {
  for (const path of paths) if (existsSync(path)) return path;
  return null;
}

/**
 * Both spellings of every path, because Seatbelt matches the resolved one (`/tmp` is
 * `/private/tmp` on macOS) and the original still covers the link being opened.
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
 * `realpath` on the longest part of the path that exists, with the rest put back,
 * because a denied path often does not exist yet and `realpathSync` throws on those.
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
