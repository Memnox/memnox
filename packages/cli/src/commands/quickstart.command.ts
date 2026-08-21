import type { Command } from 'commander';
import type { CliContext } from '../cli-context';
import { DEFAULT_POLICY_FILE } from '../defaults';
import { ensurePolicyFile } from '../project-setup';

/** Every step here is one the other commands expose on their own. */
export function registerQuickstartCommand(program: Command, context: CliContext): void {
  program
    .command('quickstart')
    .description('Set up starter policies in one step')
    .option('-f, --file <path>', 'policy file path', DEFAULT_POLICY_FILE)
    .action(async (options: { file: string }) => {
      await ensurePolicyFile(options.file, context.out, {});

      context.out.line('');
      context.out.line(`memnox serve --policies ${options.file} --enforcement monitor`);
      context.out.note('');
      context.out.note(
        'That watches without blocking. Drop --enforcement once the decisions look right.',
      );
      context.out.note('Everything runs locally — no account, no network, no limits.');
    });
}
