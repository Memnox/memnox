import type { Command } from 'commander';
import type { CliContext } from '../cli-context';
import { DEFAULT_BASE_URL } from '../defaults';

export function registerCheckCommand(program: Command, context: CliContext): void {
  program
    .command('check')
    .description('Ask the runtime for a decision on one action')
    .requiredOption('--token <token>', 'agent token')
    .requiredOption('--action <action>', 'namespaced action, e.g. database.delete')
    .option('--target <target>', 'action target, e.g. production.users')
    .option('--env <environment>', 'environment, e.g. production')
    .option('--approval <id>', 'present a previously granted approval')
    .option('--session <id>', 'group this action into a session for replay')
    .option('--url <url>', 'runtime base URL', DEFAULT_BASE_URL)
    .action(
      async (options: {
        token: string;
        action: string;
        target?: string;
        env?: string;
        approval?: string;
        session?: string;
        url: string;
      }) => {
        const client = context.client(options);
        const decision = await client.check({
          action: options.action,
          target: options.target,
          environment: options.env,
          approvalId: options.approval,
          sessionId: options.session,
        });
        context.out.line(`Decision : ${decision.effect.toUpperCase()}`);
        context.out.line(`Risk     : ${decision.riskLevel}`);
        context.out.line(`Reason   : ${decision.reason}`);
        if (decision.matchedPolicies.length > 0) {
          context.out.line(
            `Policies : ${decision.matchedPolicies.map((p) => p.name).join(', ')}`,
          );
        }
        if (decision.approvalId) context.out.line(`Approval : ${decision.approvalId}`);
      },
    );
}
