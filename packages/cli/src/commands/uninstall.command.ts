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
import { profilesFor, removeFromProfile } from '../protect/shell-profile';
import { POLICY_FILES } from '../policy-path';

interface UninstallDeps {
  home?: () => string;
  dir?: () => string;
  /** Unwrapping is the MCP command's job; injected so this stays testable. */
  unwrap?: () => Promise<number>;
  now?: () => Date;
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
      const { out } = context;

      const interceptors = await removeInterceptors(home);
      out.line(
        interceptors.length === 0
          ? 'No interceptors were installed.'
          : `Removed ${interceptors.length} interceptor(s) from ${interceptorDirFor(home)}.`,
      );

      /* The one thing we ever write outside ~/.memnox, so it is the one thing that
         would outlive an uninstall if this did not take it back out. */
      for (const path of profilesFor(process.env['SHELL'] ?? 'zsh', home)) {
        const edit = await removeFromProfile(path);
        if (edit.state === 'removed') out.line(`Removed our PATH line from ${path}.`);
      }

      /* Nothing may still be held by a seam that is no longer installed. The records
         stay — what was held and when is history — but nothing is left in force. */
      const released = await releaseEveryLease(home, (deps.now ?? (() => new Date()))());
      if (released > 0) {
        out.line(`Released ${released} lease(s); no path is held any more.`);
      }

      /* Operational state, not history and not rules: a pause or a held call left
         behind would silently stop the next install before it had done anything. */
      const cleared = await clearOperationalState(home);
      if (cleared > 0) {
        out.line(`Cleared ${cleared} held or paused item(s).`);
      }

      const hooks = await removeGitHooks(dir);
      out.line(
        hooks.length === 0
          ? 'No Memnox git hooks in this repository.'
          : `Removed the ${hooks.join(' and ')} hook(s).`,
      );

      if (deps.unwrap !== undefined) {
        const restored = await deps.unwrap();
        out.line(
          restored === 0
            ? 'No MCP server was wrapped.'
            : `Restored ${restored} MCP server(s).`,
        );
      } else {
        out.note('Run "memnox mcp unwrap" to put your MCP servers back.');
      }

      if (options.purge !== true) {
        out.line('');
        out.line(`Your rules and history are still in ${join(home, MEMNOX_HOME)}.`);
        out.line('Add --purge to delete those too.');
        return;
      }

      await rm(join(home, MEMNOX_HOME), { recursive: true, force: true });
      out.line('');
      out.line(`Deleted ${join(home, MEMNOX_HOME)}.`);

      /* The rule file lives in the repository and is very likely committed, so it is
         not ours to delete — but claiming nothing is left while it sits there is the
         kind of small untruth that makes somebody stop trusting the rest. */
      const rules = POLICY_FILES.map((name) => join(dir, name)).filter(existsSync);
      if (rules.length === 0) {
        out.line('Nothing of Memnox is left on this machine.');
      } else {
        for (const path of rules) {
          out.line(
            `Your rules are still at ${path} — they are yours, and probably committed.`,
          );
        }
      }
      // Ours came out above; a line somebody pasted themselves is theirs to remove.
      out.note(
        'If you added the interceptor directory to PATH by hand, remove that line.',
      );
    });
}
