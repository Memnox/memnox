import { homedir } from 'node:os';
import { cwd } from 'node:process';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { Command } from 'commander';
import { MEMNOX_HOME } from '@memnox/core';
import {
  interceptorDirFor,
  removeGitHooks,
  removeInterceptors,
} from '@memnox/interceptors';
import type { CliContext } from '../cli-context';

interface UninstallDeps {
  home?: () => string;
  dir?: () => string;
  /** Unwrapping is the MCP command's job; injected so this stays testable. */
  unwrap?: () => Promise<number>;
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
      out.line(`Deleted ${join(home, MEMNOX_HOME)}. Nothing of Memnox is left here.`);
      // PATH is the one thing we cannot undo: we never wrote to a shell profile.
      out.note(
        'If you added the interceptor directory to PATH by hand, remove that line.',
      );
    });
}
