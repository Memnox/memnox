import type { Command } from 'commander';
import type { CliContext } from '../cli-context';
import { loadPoliciesFromFile } from '@memnox/local-gate';
import { DEFAULT_POLICY_FILE } from '../defaults';

export function registerValidateCommand(program: Command, context: CliContext): void {
  program
    .command('validate [file]')
    .description('Validate a YAML policy file')
    .action(async (file: string = DEFAULT_POLICY_FILE) => {
      const policies = await loadPoliciesFromFile(file);
      context.out.line(`${file} is valid — ${policies.length} policy(ies):`);
      for (const policy of policies) {
        context.out.line(`  - ${policy.name} → ${policy.decision.effect}`);
      }
    });
}
