/**
 * `memnox uninstall`: every piece of Memnox off this machine, in one command, the service
 * first because it restarts itself. What is left behind is said plainly.
 */

import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { cwd } from 'node:process';
import type { Command } from 'commander';
import {
  fleetSpendPathFor,
  LEASE_OUTCOME,
  LeaseRegistry,
  leaseDirFor,
  MEMNOX_HOME,
  pauseDirFor,
  pendingDirFor,
  taskDirFor,
} from '@memnox/core';
import {
  interceptorDirFor,
  removeGitHooks,
  removeInterceptors,
} from '@memnox/interceptors';
import type { CliContext } from '../cli-context';
import { removeClaudeHook } from '../protect/claude-hook';
import { forgetKept } from '../keeper/kept';
import { forgetKeeperState } from '../keeper/keeper-state';
import {
  removeCodexHook,
  removeCursorHook,
  removeGeminiHook,
  removeWindsurfHook,
} from '../protect/agent-hooks';
import {
  DEFAULT_SHELL,
  PROFILE_STATE,
  profilesFor,
  removeFromProfile,
} from '../protect/shell-profile';
import { POLICY_FILES } from '../policy-path';
import { uninstallService } from '../daemon/service';
import { removeEverywhere } from '../session-tools/session-entry';

interface UninstallDeps {
  home?: () => string;
  dir?: () => string;
  env?: NodeJS.ProcessEnv;
  /** Unwrapping is the MCP command's job; injected so this stays testable. */
  unwrap?: () => Promise<number>;
  now?: () => Date;
  /** Injected so a test never asks the real service manager to stop anything. */
  unservice?: typeof uninstallService;
}

/**
 * Everything that stops work without being a rule: held calls, paused sessions, declared
 * tasks, leases and fleet totals. None of it is history, and all of it would govern a fresh install.
 */
async function clearOperationalState(home: string): Promise<number> {
  const paths = [
    pendingDirFor(home),
    pauseDirFor(home),
    taskDirFor(home),
    leaseDirFor(home),
    fleetSpendPathFor(home),
  ];
  let cleared = 0;
  for (const path of paths) {
    // Counted only when something was there, because `force` succeeds on a missing path.
    if (!existsSync(path)) continue;
    await rm(path, { recursive: true, force: true });
    cleared += 1;
  }
  return cleared;
}

/** Quiet on failure: a register that will not open must not stop an uninstall. */
async function releaseEveryLease(home: string, now: Date): Promise<number> {
  try {
    const registry = new LeaseRegistry(home);
    const moment = now.toISOString();
    let released = 0;
    for (const lease of await registry.held(moment)) {
      const done = await registry.release(lease.id, lease.holder, moment);
      if (done.outcome === LEASE_OUTCOME.TAKEN) released += 1;
    }
    return released;
  } catch {
    return 0;
  }
}

/** A tool that can be removed cleanly is a tool people are willing to try. */
export function registerUninstallCommand(
  program: Command,
  context: CliContext,
  deps: UninstallDeps = {},
): void {
  program
    .command('uninstall')
    .description('Remove the interceptors, the hooks and the wrapping from this machine')
    .option('--purge', 'also delete ~/.memnox, including the history and your rules')
    .action(async (options: UninstallOptions) => runUninstall(context, deps, options));
}

interface UninstallOptions {
  purge?: boolean;
}

/**
 * Takes every piece of Memnox off this machine, each step reporting what it took, so the
 * closing line is assembled from what happened rather than from what was intended.
 */
async function runUninstall(
  context: CliContext,
  deps: UninstallDeps,
  options: UninstallOptions,
): Promise<void> {
  const home = (deps.home ?? homedir)();
  const dir = (deps.dir ?? cwd)();
  context.flow.open('memnox uninstall');

  // First, so a daemon still running between these steps has nothing left to put back.
  await forgetKept(home);
  await forgetKeeperState(home);
  const taken: string[] = [
    ...(await removeTheInterceptors(context, home)),
    ...(await removeTheEditorHooks(context, home)),
    ...(await removeTheSessionTools(context, home)),
    ...(await removeTheDaemonService(context, deps, home)),
  ];
  await removeThePathLine(context, deps, home);
  await releaseWhatIsHeld(context, deps, home);
  taken.push(
    ...(await removeTheGitHooks(context, dir)),
    ...(await unwrapTheMcpServers(context, deps)),
  );

  if (options.purge !== true) return reportKept(context, home, taken);
  return reportPurged(context, home, dir);
}

/** The PATH wrappers, which are the seam in front of every shell command. */
async function removeTheInterceptors(
  context: CliContext,
  home: string,
): Promise<string[]> {
  const interceptors = await removeInterceptors(home);
  context.flow.step(
    'Interceptors',
    interceptors.length === 0
      ? 'none were installed'
      : `removed ${interceptors.length} from ${interceptorDirFor(home)}`,
  );
  return interceptors.length > 0 ? ['the interceptors'] : [];
}

/** The lease hook each coding agent runs before it writes a file. */
async function removeTheEditorHooks(
  context: CliContext,
  home: string,
): Promise<string[]> {
  const claude = await removeClaudeHook(home);
  context.flow.step(
    'Claude Code hook',
    claude ? 'taken out of its settings' : 'none was installed',
  );

  const others = [
    ['Codex', await removeCodexHook(home)],
    ['Cursor', await removeCursorHook(home)],
    ['Gemini CLI', await removeGeminiHook(home)],
    ['Windsurf', await removeWindsurfHook(home)],
  ] as const;
  const editors = others.filter(([, removed]) => removed).map(([name]) => name);

  context.flow.step(
    "Other coding agents' hooks",
    editors.length === 0
      ? 'none were installed'
      : `taken out of ${editors.join(' and ')}`,
  );
  return [
    ...(claude ? ['the Claude Code hook'] : []),
    ...editors.map((editor) => `the ${editor} hook`),
  ];
}

/** The session server entry in each agent's MCP config, and nothing beside it. */
async function removeTheSessionTools(
  context: CliContext,
  home: string,
): Promise<string[]> {
  const from = await removeEverywhere(home);
  context.flow.step(
    'Session tools',
    from.length === 0 ? 'none were installed' : `taken out of ${from.join(' and ')}`,
  );
  return from.length > 0 ? ['the session tools'] : [];
}

/** The service, taken out before the wrappers because a loaded one would restart the daemon. */
async function removeTheDaemonService(
  context: CliContext,
  deps: UninstallDeps,
  home: string,
): Promise<string[]> {
  const service = await (deps.unservice ?? uninstallService)(home);
  const installed = service.state.supported && service.state.path !== '';

  context.flow.step('Daemon', describeServiceRemoval(installed, service.warning));
  return installed ? ['the daemon service'] : [];
}

function describeServiceRemoval(installed: boolean, warning: string | undefined): string {
  if (!installed) return 'nothing was starting it';
  if (warning === undefined) return 'stopped, and this machine no longer starts it';
  return `file removed, but it would not stop (${warning})`;
}

/** The line in the login shell profile, the one thing ever written outside `~/.memnox`. */
async function removeThePathLine(
  context: CliContext,
  deps: UninstallDeps,
  home: string,
): Promise<void> {
  const shell = (deps.env ?? process.env)['SHELL'] ?? DEFAULT_SHELL;
  for (const path of profilesFor(shell, home)) {
    const edit = await removeFromProfile(path);
    if (edit.state === PROFILE_STATE.REMOVED) {
      context.flow.step('Shell profile', `our PATH line is out of ${path}`);
    }
  }
}

/**
 * Leases and held work, released so nothing is held by a seam that is no longer installed.
 * The records stay, because what was held and when is history.
 */
async function releaseWhatIsHeld(
  context: CliContext,
  deps: UninstallDeps,
  home: string,
): Promise<void> {
  const released = await releaseEveryLease(home, (deps.now ?? (() => new Date()))());
  if (released > 0) {
    context.flow.step('Leases', `released ${released}; no path is held any more`);
  }
  const cleared = await clearOperationalState(home);
  if (cleared > 0) {
    context.flow.step('Held work', `cleared ${cleared} held or paused item(s)`);
  }
}

/** The pre-push and pre-commit hooks, which live in this repository rather than at home. */
async function removeTheGitHooks(context: CliContext, dir: string): Promise<string[]> {
  const hooks = await removeGitHooks(dir);
  context.flow.step(
    'Git hooks',
    hooks.length === 0
      ? 'none of ours in this repository'
      : `removed the ${hooks.join(' and ')} hook(s)`,
  );
  return hooks.length > 0 ? ['the git hooks'] : [];
}

/** The MCP configs, put back the way each agent had them. */
async function unwrapTheMcpServers(
  context: CliContext,
  deps: UninstallDeps,
): Promise<string[]> {
  if (deps.unwrap === undefined) {
    context.flow.step('MCP servers', 'not touched from here');
    context.flow.aside('Run "memnox mcp unwrap" to put your MCP servers back.');
    return [];
  }
  const restored = await deps.unwrap();
  context.flow.step(
    'MCP servers',
    restored === 0 ? 'none was wrapped' : `restored ${restored}`,
  );
  return restored > 0 ? ['the MCP wrapping'] : [];
}

/** What is deliberately left behind when nobody asked for a purge. */
function reportKept(context: CliContext, home: string, taken: readonly string[]): void {
  const { flow } = context;
  flow.rows('Still here', [
    { label: 'rules', value: join(home, MEMNOX_HOME) },
    { label: 'history', value: 'the same place, and still yours' },
  ]);
  flow.close(
    taken.length === 0
      ? 'Nothing of ours was installed on this machine.'
      : `Removed ${taken.join(', ')}.`,
  );
  flow.hint('Add --purge to delete your rules and history too.');
}

/**
 * Everything of ours deleted, and the rule files named rather than removed, because a
 * rule file lives in the repository and is very likely committed.
 */
async function reportPurged(
  context: CliContext,
  home: string,
  dir: string,
): Promise<void> {
  const { flow, style } = context;
  await rm(join(home, MEMNOX_HOME), { recursive: true, force: true });

  const rules = POLICY_FILES.map((name) => join(dir, name)).filter(existsSync);
  flow.rows('Deleted', [
    { label: 'home', value: join(home, MEMNOX_HOME) },
    ...rules.map((path) => ({
      label: 'kept',
      value: `${path}, because it is yours and probably committed`,
    })),
  ]);
  flow.close(
    rules.length === 0
      ? style.ok('Nothing of Memnox is left on this machine.')
      : 'Everything of ours is gone; your rule files are where you put them.',
  );
  // Ours came out above; a line somebody pasted themselves is theirs to remove.
  flow.hint('If you added the interceptor directory to PATH by hand, remove that line.');
}
