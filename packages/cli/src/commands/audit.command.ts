import type { Command } from 'commander';
import type { CliContext } from '../cli-context';
import { DEFAULT_BASE_URL, DEFAULT_CLI_AUDIT_LIMIT } from '../defaults';

interface AuditOptions {
  url?: string;
  adminToken?: string;
}

/** Two repositories of one project share a scope, so the timeline has to span both. */
const PROJECT_FLAG = '--project <name>';
const EFFECT_COLUMN_WIDTH = 16;

export function registerAuditCommand(program: Command, context: CliContext): void {
  const audit = program
    .command('audit')
    .description('Show the most recent action decisions')
    .option('--limit <n>', 'number of events', String(DEFAULT_CLI_AUDIT_LIMIT))
    .option(PROJECT_FLAG, 'only actions belonging to this project')
    .option('--url <url>', `runtime base URL (default: ${DEFAULT_BASE_URL})`)
    .option('--admin-token <token>', 'admin token if the runtime requires one')
    .action(async (options: AuditOptions & { limit: string; project?: string }) => {
      const { out, style } = context;
      const limit = Number(options.limit);
      const { client } = await context.connect(options);
      const events =
        options.project === undefined
          ? await client.recentAudit(limit)
          : (await client.queryAudit({ projectId: options.project, limit })).reverse();
      if (events.length === 0) {
        out.line(
          options.project === undefined
            ? 'No audited actions yet.'
            : `No audited actions for project "${options.project}" yet.`,
        );
        out.note('');
        out.note(
          '→ Nothing has asked for a decision yet. Try:  memnox check --action file.read',
        );
        return;
      }
      for (const event of events) {
        const target = event.target ? ` ${event.target}` : '';
        const env = event.environment ? ` [${event.environment}]` : '';
        // Padded before styling: escape codes would count toward the column width.
        const effect = style.effect(
          event.effect,
          event.effect.toUpperCase().padEnd(EFFECT_COLUMN_WIDTH),
        );
        out.line(
          `${style.dim(event.occurredAt)}  ${effect} ${event.agentName}: ${event.action}${target}${env} — ${event.reason}`,
        );
      }
    });

  audit
    .command('verify')
    .description('Verify the audit hash chain and report the first broken link')
    // Connection flags stay on the parent: declaring them here too makes commander
    // bind the flag to the parent and hand this action only its own default.
    .action(async function (this: Command) {
      const options = this.optsWithGlobals() as AuditOptions;
      const { client } = await context.connect(options);
      const result = await client.verifyAudit();
      if (result.valid) {
        context.out.line(`Audit chain intact — ${result.checked} events verified.`);
        return;
      }
      // Throwing is the single failure path: index.ts prints it and sets the exit code.
      throw new Error(
        `Audit chain BROKEN at event #${result.brokenAtIndex} (${result.brokenEventId ?? 'unknown'}): ${result.brokenReason ?? 'unknown reason'}`,
      );
    });
}
