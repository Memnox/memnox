import { homedir } from 'node:os';
import { cwd } from 'node:process';
import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
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
import {
  removeCodexHook,
  removeCursorHook,
  removeGeminiHook,
  removeWindsurfHook,
} from '../protect/agent-hooks';
import { profilesFor, removeFromProfile } from '../protect/shell-profile';
import { POLICY_FILES } from '../policy-path';
import { uninstallService } from '../daemon/service';

interface UninstallDeps {
  home?: () => string;
  dir?: () => string;
  /** Unwrapping is the MCP command's job; injected so this stays testable. */
  unwrap?: () => Promise<number>;
  now?: () => Date;
  /** Injected so a test never asks the real service manager to stop anything. */
  unservice?: typeof uninstallService;
}

/**
 * Everything that stops work without being a rule: held calls, paused sessions, the
 * task a session declared, and the fleet totals that were true for a fleet this
 * machine has left. None of it is history, and every one of them would silently
 * govern a fresh install that had not asked for it.
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
    /* Counted only when something was actually there. `rm --force` succeeds on a
       path that never existed, so counting the calls would tell every fresh machine
       it had just cleared five things. */
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

/**
 * Everything this product put on a machine, taken off in one command. A tool that can
 * be removed cleanly is a tool people are willing to try; one that cannot is one they
 * never install.
 */
export function registerUninstallCommand(
  program: Command,
  context: CliContext,
  deps: UninstallDeps = {},
): void {
  program
    .command('uninstall')
    .description('Remove the interceptors, the hooks and the wrapping from this machine')
    .option('--purge', 'also delete ~/.memnox, including the history and your rules')
    .action(async (options: { purge?: boolean }) => {
      const home = (deps.home ?? homedir)();
      const dir = (deps.dir ?? cwd)();
      const { flow, style } = context;
      flow.open('memnox uninstall');

      const taken: string[] = [];

      const interceptors = await removeInterceptors(home);
      flow.step(
        'Interceptors',
        interceptors.length === 0
          ? 'none were installed'
          : `removed ${interceptors.length} from ${interceptorDirFor(home)}`,
      );
      if (interceptors.length > 0) taken.push('the interceptors');

      const claudeHook = await removeClaudeHook(home);
      flow.step(
        'Claude Code hook',
        claudeHook ? 'taken out of its settings' : 'none was installed',
      );
      if (claudeHook) taken.push('the Claude Code hook');

      const codexHook = await removeCodexHook(home);
      const cursorHook = await removeCursorHook(home);
      const geminiHook = await removeGeminiHook(home);
      const windsurfHook = await removeWindsurfHook(home);
      const editors = [
        ...(codexHook ? ['Codex'] : []),
        ...(cursorHook ? ['Cursor'] : []),
        ...(geminiHook ? ['Gemini CLI'] : []),
        ...(windsurfHook ? ['Windsurf'] : []),
      ];
      flow.step(
        "Other coding agents' hooks",
        editors.length === 0
          ? 'none were installed'
          : `taken out of ${editors.join(' and ')}`,
      );
      for (const editor of editors) taken.push(`the ${editor} hook`);

      /* Taken out before the wrappers, because it is the one piece that restarts
         itself: a service left loaded would keep a daemon alive against a machine
         this command has just stripped, and `setup` installs one now, so an
         uninstall that skipped it would leave the thing most able to outlive it. */
      const service = await (deps.unservice ?? uninstallService)(home);
      flow.step(
        'Daemon',
        !service.state.supported || service.state.path === ''
          ? 'nothing was starting it'
          : service.warning === undefined
            ? 'stopped, and this machine no longer starts it'
            : `file removed, but it would not stop (${service.warning})`,
      );
      if (service.state.supported && service.state.path !== '') {
        taken.push('the daemon service');
      }

      /* The one thing we ever write outside ~/.memnox, so it is the one thing that
         would outlive an uninstall if this did not take it back out. */
      for (const path of profilesFor(process.env['SHELL'] ?? 'zsh', home)) {
        const edit = await removeFromProfile(path);
        if (edit.state === 'removed')
          flow.step('Shell profile', `our PATH line is out of ${path}`);
      }

      /* Nothing may still be held by a seam that is no longer installed. The records
         stay — what was held and when is history — but nothing is left in force. */
      const released = await releaseEveryLease(home, (deps.now ?? (() => new Date()))());
      if (released > 0) {
        flow.step('Leases', `released ${released}; no path is held any more`);
      }

      /* Operational state, not history and not rules: a pause or a held call left
         behind would silently stop the next install before it had done anything. */
      const cleared = await clearOperationalState(home);
      if (cleared > 0) {
        flow.step('Held work', `cleared ${cleared} held or paused item(s)`);
      }

      const hooks = await removeGitHooks(dir);
      flow.step(
        'Git hooks',
        hooks.length === 0
          ? 'none of ours in this repository'
          : `removed the ${hooks.join(' and ')} hook(s)`,
      );
      if (hooks.length > 0) taken.push('the git hooks');

      if (deps.unwrap !== undefined) {
        const restored = await deps.unwrap();
        flow.step(
          'MCP servers',
          restored === 0 ? 'none was wrapped' : `restored ${restored}`,
        );
        if (restored > 0) taken.push('the MCP wrapping');
      } else {
        flow.step('MCP servers', 'not touched from here');
        flow.aside('Run "memnox mcp unwrap" to put your MCP servers back.');
      }

      if (options.purge !== true) {
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
        return;
      }

      await rm(join(home, MEMNOX_HOME), { recursive: true, force: true });

      /* The rule file lives in the repository and is very likely committed, so it is
         not ours to delete — but claiming nothing is left while it sits there is the
         kind of small untruth that makes somebody stop trusting the rest. */
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
      flow.hint(
        'If you added the interceptor directory to PATH by hand, remove that line.',
      );
    });
}
