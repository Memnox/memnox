import type { Command } from 'commander';
import type { CliContext } from '../cli-context';
import { DEFAULT_BASE_URL } from '../defaults';
import { formatDuration } from '../duration';
import { resolveWhoAmI } from '../whoami';

interface ConnectionFlags {
  url?: string;
  adminToken?: string;
}

/** Every approval command takes the same two connection flags. */
const withConnection = (command: Command): Command =>
  command
    .option('--url <url>', `runtime base URL (default: ${DEFAULT_BASE_URL})`)
    .option('--admin-token <token>', 'admin token if the runtime requires one');

export function registerApprovalsCommand(program: Command, context: CliContext): void {
  const listPending = async (options: ConnectionFlags): Promise<void> => {
    const { client } = await context.connect(options);
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
    context.out.note('');
    context.out.note('→ Grant one:  memnox approve <id>');
  };

  // Bare `memnox approvals` lists them: the subcommand carried no information.
  const approvals = withConnection(
    program.command('approvals').description('Review pending approvals'),
  ).action(async function (this: Command) {
    await listPending(this.opts() as ConnectionFlags);
  });

  // Connection flags live on the parent only. Declaring them here too makes
  // commander bind --url to the parent and hand this action its own default,
  // so `approvals list --url X` silently queried somewhere else entirely.
  approvals
    .command('list')
    .description('List pending approvals')
    .action(async function (this: Command) {
      await listPending(this.optsWithGlobals() as ConnectionFlags);
    });

  const resolve = async (
    id: string,
    approved: boolean,
    options: ConnectionFlags & { by?: string },
  ): Promise<void> => {
    const by = options.by ?? resolveWhoAmI(process.env);
    const { client } = await context.connect(options);
    const approval = await client.resolveApproval(id, approved, by);
    context.out.line(
      `Approval ${approval.id}: ${approval.status} by ${approval.resolvedBy}`,
    );
  };

  // Top-level because these two are the whole daily loop; nesting them under
  // `approvals resolve --by <name>` made the common case the longest to type.
  withConnection(
    program
      .command('approve <id>')
      .description('Grant a pending approval')
      .option(
        '--by <name>',
        'who is approving — recorded as the grantor, not verified against the approver list (default: $USER)',
      ),
  ).action(async (id: string, options: ConnectionFlags & { by?: string }) =>
    resolve(id, true, options),
  );

  withConnection(
    program
      .command('deny <id>')
      .description('Deny a pending approval')
      .option(
        '--by <name>',
        'who is denying — recorded as the grantor, not verified against the approver list (default: $USER)',
      ),
  ).action(async (id: string, options: ConnectionFlags & { by?: string }) =>
    resolve(id, false, options),
  );

  approvals
    .command('status <id>')
    .description('Show one approval — who has granted it and what is still needed')
    .action(async function (this: Command, id: string) {
      const { client } = await context.connect(this.optsWithGlobals() as ConnectionFlags);
      const approval = await client.approvalStatus(id);
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
      context.out.line(`Asked of : ${approval.approvers.join(', ')}`);
      // `approvers` names groups; grants carry individuals, so membership cannot
      // be checked here. Naming the off-list grantors is what makes that visible.
      const offList = approval.grants
        .map((grant) => grant.by)
        .filter((by) => !approval.approvers.includes(by));
      if (offList.length > 0) {
        context.out.line(
          `  note   : ${offList.join(', ')} granted without matching a named approver`,
        );
      }
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
    .action(async function (this: Command) {
      const { client } = await context.connect(this.optsWithGlobals() as ConnectionFlags);
      const summary = await client.approvalHealth();
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

  // Kept as the explicit form; `memnox approve` / `memnox deny` are the short ones.
  approvals
    .command('resolve <id>')
    .description('Approve or deny a pending approval')
    .option('--by <name>', 'who is resolving this approval (default: $USER)')
    .option('--deny', 'deny instead of approve')
    .action(async function (this: Command, id: string) {
      const options = this.optsWithGlobals() as ConnectionFlags & {
        by?: string;
        deny?: boolean;
      };
      await resolve(id, options.deny !== true, options);
    });

  approvals
    .command('override <id>')
    .description('Break-glass: approve a pending approval as admin (audited as critical)')
    .requiredOption('--reason <text>', 'why this override is justified')
    .action(async function (this: Command, id: string) {
      const options = this.optsWithGlobals() as ConnectionFlags & { reason: string };
      const { client } = await context.connect(options);
      const approval = await client.overrideApproval(id, options.reason);
      context.out.line(
        `Approval ${approval.id}: ${approval.status} (override) by ${approval.resolvedBy}`,
      );
    });
}
