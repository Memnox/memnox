import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import type { Command } from 'commander';
import type { CliContext } from '../cli-context';
import { EditorHookInstaller } from '../editor-hook-installer';
import { SUPPORTED_HOOK_AGENTS } from './hook.command';

/** GUI-launched editors do not inherit the shell PATH, so both paths are absolute. */
function hookCommandFor(agent: string): string {
  return `${process.execPath} ${fileURLToPath(import.meta.url)} hook ${agent}`;
}

export function registerProtectCommand(
  program: Command,
  context: CliContext,
  installer = new EditorHookInstaller(homedir(), hookCommandFor),
): void {
  program
    .command('protect [agent]')
    .description(
      `Install the Memnox hook for an agent (${SUPPORTED_HOOK_AGENTS.join('|')}); omit to detect installed editors`,
    )
    .action(async (agent: string | undefined) => {
      const reports = agent
        ? [await installer.install(agent)]
        : await installer.installDetected();

      if (reports.length === 0) {
        context.out.line('No supported editors detected in your home directory.');
        context.out.line(
          `Install one explicitly: memnox protect <${SUPPORTED_HOOK_AGENTS.join('|')}>`,
        );
        return;
      }
      for (const report of reports) {
        context.out.line(
          report.installed
            ? `  installed  ${report.agent} → ${report.path}`
            : `  already    ${report.agent} → ${report.path}`,
        );
      }
      context.out.line(
        '\nSet MEMNOX_AGENT_TOKEN (from "memnox agents register") and restart your editor.',
      );
    });
}
