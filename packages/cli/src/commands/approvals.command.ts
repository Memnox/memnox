import type { Command } from 'commander';
import type { CliContext } from '../cli-context';
import { DEFAULT_BASE_URL } from '../defaults';
import { formatDuration } from '../duration';

export function registerApprovalsCommand(program: Command, context: CliContext): void {
  const approvals = program.command('approvals').description('Review pending approvals');

  approvals
    .command('list')
    .description('List pending approvals')
    .option('--url <url>', 'runtime base URL', DEFAULT_BASE_URL)
    .option('--admin-token <token>', 'admin token if the runtime requires one')
    .action(async (options: { url: string; adminToken?: string }) => {
      const client = context.client(options);
      const pending = await client.pendingApprovals();
      if (pending.length === 0) {
        context.out.line('No pending approvals.');
        return;
      }
      for (const approval of pending) {
        const target = approval.target ? ` ${approval.target}` : '';
        const env = approval.environment ? ` [${approval.environment}]` : '';
        context.out.line(
          `${approval.id}  ${approval.action}${target}${env} — approvers: ${approval.approvers.join(', ')}`,
        );
      }
    });

  approvals
    .command('status <id>')
    .description('Show one approval — who has granted it and what is still needed')
    .option('--url <url>', 'runtime base URL', DEFAULT_BASE_URL)
    .option('--admin-token <token>', 'admin token if the runtime requires one')
    .action(async (id: string, options: { url: string; adminToken?: string }) => {
      const approval = await context.client(options).approvalStatus(id);
      const target = approval.target ? ` ${approval.target}` : '';
      const env = approval.environment ? ` [${approval.environment}]` : '';
      context.out.line(`Approval : ${approval.id}`);
      context.out.line(`Action   : ${approval.action}${target}${env}`);
      context.out.line(`Status   : ${approval.status}`);
      context.out.line(
        `Granted  : ${approval.grants.length}/${approval.minApprovals}` +
          (approval.grants.length > 0
            ? ` (${approval.grants.map((grant) => grant.by).join(', ')})`
            : ''),
      );
      context.out.line(`Approvers: ${approval.approvers.join(', ')}`);
      if (approval.expiresAt) context.out.line(`Expires  : ${approval.expiresAt}`);
      if (approval.resolvedBy) {
        context.out.line(
          `Resolved : by ${approval.resolvedBy}${approval.override ? ' (override)' : ''}`,
        );
      }
    });

  approvals
    .command('health')
    .description('Where approvals stall: resolve times, what lapsed, break-glass use')
    .option('--url <url>', 'runtime base URL', DEFAULT_BASE_URL)
    .option('--admin-token <token>', 'admin token if the runtime requires one')
    .action(async (options: { url: string; adminToken?: string }) => {
      const summary = await context.client(options).approvalHealth();
      context.out.line(`Approvals      : ${summary.total}`);
      context.out.line(`Pending        : ${summary.pending}`);
      context.out.line(`Approved       : ${summary.approved}`);
      context.out.line(`Denied         : ${summary.denied}`);
      context.out.line(`Lapsed unread  : ${summary.lapsed}`);
      context.out.line(`Break-glass    : ${summary.overrides}`);
      context.out.line(
        `Median resolve : ${formatDuration(summary.medianResolveMinutes)}`,
      );
      context.out.line(`p90 resolve    : ${formatDuration(summary.p90ResolveMinutes)}`);
      context.out.line(
        `Oldest pending : ${formatDuration(summary.oldestPendingMinutes)}`,
      );
      if (summary.approverActivity.length > 0) {
        context.out.line('\nGrants per approver:');
        for (const entry of summary.approverActivity) {
          context.out.line(`  - ${entry.approver} (${entry.grants})`);
        }
      }
    });

  approvals
    .command('resolve <id>')
    .description('Approve or deny a pending approval')
    .requiredOption('--by <name>', 'who is resolving this approval')
    .option('--deny', 'deny instead of approve')
    .option('--url <url>', 'runtime base URL', DEFAULT_BASE_URL)
    .option('--admin-token <token>', 'admin token if the runtime requires one')
    .action(
      async (
        id: string,
        options: { by: string; deny?: boolean; url: string; adminToken?: string },
      ) => {
        const client = context.client(options);
        const approval = await client.resolveApproval(id, !options.deny, options.by);
        context.out.line(
          `Approval ${approval.id}: ${approval.status} by ${approval.resolvedBy}`,
        );
      },
    );

  approvals
    .command('override <id>')
    .description('Break-glass: approve a pending approval as admin (audited as critical)')
    .requiredOption('--reason <text>', 'why this override is justified')
    .option('--url <url>', 'runtime base URL', DEFAULT_BASE_URL)
    .option('--admin-token <token>', 'admin token if the runtime requires one')
    .action(
      async (
        id: string,
        options: { reason: string; url: string; adminToken?: string },
      ) => {
        const client = context.client(options);
        const approval = await client.overrideApproval(id, options.reason);
        context.out.line(
          `Approval ${approval.id}: ${approval.status} (override) by ${approval.resolvedBy}`,
        );
      },
    );
}
