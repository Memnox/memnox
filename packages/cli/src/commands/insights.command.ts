import type { Command } from 'commander';
import type { CliContext } from '../cli-context';
import { DEFAULT_BASE_URL } from '../defaults';

export function registerInsightsCommand(program: Command, context: CliContext): void {
  program
    .command('insights')
    .description('Quick protection summary: what Memnox handled and stopped')
    .option('--url <url>', 'runtime base URL', DEFAULT_BASE_URL)
    .option('--admin-token <token>', 'admin token if the runtime requires one')
    .action(async (options: { url: string; adminToken?: string }) => {
      const client = context.client(options);
      const report = await client.complianceReport({});
      context.out.line(`Protected actions : ${report.totals.actions}`);
      context.out.line(`Allowed           : ${report.totals.allowed}`);
      context.out.line(`Blocked           : ${report.totals.blocked}`);
      context.out.line(`Sent to approval  : ${report.totals.approvalsRequired}`);
      if (report.topBlockedActions.length > 0) {
        context.out.line('\nMost blocked actions:');
        for (const entry of report.topBlockedActions) {
          context.out.line(`  - ${entry.action} (${entry.count})`);
        }
      }
      if (report.advisorySignals.length > 0) {
        context.out.line('\nBehavioral signals:');
        for (const entry of report.advisorySignals) {
          context.out.line(`  - ${entry.signal} (${entry.count})`);
        }
      }
    });
}
