import type { Command } from 'commander';
import type { CliContext } from '../cli-context';
import { DEFAULT_BASE_URL } from '../defaults';
import { formatDuration } from '../duration';

export function registerInsightsCommand(program: Command, context: CliContext): void {
  program
    .command('insights')
    .description('Quick protection summary: what Memnox handled and stopped')
    .option('--url <url>', `runtime base URL (default: ${DEFAULT_BASE_URL})`)
    .option('--admin-token <token>', 'admin token if the runtime requires one')
    .action(async (options: { url?: string; adminToken?: string }) => {
      const { client } = await context.connect(options);
      const report = await client.complianceReport({});
      context.out.line(`Protected actions : ${report.totals.actions}`);
      context.out.line(`Allowed           : ${report.totals.allowed}`);
      context.out.line(`Blocked           : ${report.totals.blocked}`);
      context.out.line(`Sent to approval  : ${report.totals.approvalsRequired}`);

      const { verification } = report;
      // Above the coverage numbers on purpose: an agent reporting that it acted
      // without permission is not a reporting statistic, it is an incident.
      if (verification.defied > 0) {
        context.out.line(
          `\nActed without permission : ${verification.defied} outcome(s) claim success on an action that was not allowed`,
        );
      }
      if (verification.allowed > 0) {
        context.out.line(
          `\nOutcomes reported : ${verification.reported}/${verification.allowed} allowed decisions` +
            ` (${verification.failed} failed, ${verification.rollbackFailed} rollback failed)`,
        );
        // Silence is missing testimony, not a failure — say so rather than let a
        // large number read as an incident.
        if (verification.unreported > 0) {
          context.out.line(
            `  ${verification.unreported} reported no outcome — those callers did not use guarded execution.`,
          );
        }
      }

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

      const approvals = await client.approvalHealth();
      if (approvals.total > 0) {
        context.out.line('\nApproval flow:');
        context.out.line(`  Waiting now     : ${approvals.pending}`);
        context.out.line(`  Lapsed unread   : ${approvals.lapsed}`);
        context.out.line(`  Break-glass     : ${approvals.overrides}`);
        context.out.line(
          `  Time to resolve : ${formatDuration(approvals.medianResolveMinutes)} median, ${formatDuration(approvals.p90ResolveMinutes)} p90`,
        );
        if (approvals.oldestPendingMinutes !== null) {
          context.out.line(
            `  Oldest waiting  : ${formatDuration(approvals.oldestPendingMinutes)}`,
          );
        }
      }
    });
}
