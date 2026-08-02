import { homedir } from 'node:os';
import type { Command } from 'commander';
import type { CliContext } from '../cli-context';
import { EditorHookInstaller } from '../editor-hook-installer';
import { DEFAULT_POLICY_FILE } from '../defaults';
import { ensurePolicyFile, hookCommandFor } from '../project-setup';
import { SUPPORTED_HOOK_AGENTS } from './hook.command';

const DEFAULT_AGENT = 'claude-code';

/**
 * One command from nothing to governed: write a policy file, install the
 * editor hook, and print how to start in monitor mode. Everything it does is
 * a step the other commands expose on their own.
 */
export function registerQuickstartCommand(
  program: Command,
  context: CliContext,
  installer = new EditorHookInstaller(homedir(), hookCommandFor),
): void {
  program
    .command('quickstart [agent]')
    .description('Set up policies and editor hooks in one step')
    .option('-f, --file <path>', 'policy file path', DEFAULT_POLICY_FILE)
    .option('--no-hook', 'skip installing the editor hook')
    .action(
      async (agent: string | undefined, options: { file: string; hook: boolean }) => {
        const target = agent ?? DEFAULT_AGENT;
        if (!SUPPORTED_HOOK_AGENTS.includes(target)) {
          throw new Error(
            `unknown agent "${target}" — one of: ${SUPPORTED_HOOK_AGENTS.join(', ')}`,
          );
        }

        await ensurePolicyFile(options.file, context.out, {});

        if (options.hook) {
          await installer.install(target);
          context.out.line(`Installed the ${target} hook`);
        }

        context.out.line('');
        context.out.line(`memnox serve --policies ${options.file} --enforcement monitor`);
        context.out.note('');
        context.out.note(
          'That watches without blocking. Drop --enforcement once the decisions look right.',
        );
        context.out.note('Everything runs locally — no account, no network, no limits.');
      },
    );
}
