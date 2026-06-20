import { writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import type { Command } from 'commander';
import type { CliContext } from '../cli-context';
import { DEFAULT_POLICY_FILE, STARTER_POLICY_FILE } from '../defaults';

export function registerInitCommand(program: Command, context: CliContext): void {
  program
    .command('init')
    .description('Create a starter policy file in the current directory')
    .option('-f, --file <path>', 'policy file path', DEFAULT_POLICY_FILE)
    .action(async (options: { file: string }) => {
      if (existsSync(options.file)) {
        throw new Error(`${options.file} already exists — refusing to overwrite`);
      }
      await writeFile(options.file, STARTER_POLICY_FILE, 'utf8');
      context.out.line(`Created ${options.file}`);
      // Monitor-first: see what these rules would do before they can stop anyone.
      context.out.note(
        `Next: memnox serve --policies ${options.file} --enforcement monitor`,
      );
      context.out.note(
        'That observes and records without blocking. Drop --enforcement to enforce.',
      );
    });
}
