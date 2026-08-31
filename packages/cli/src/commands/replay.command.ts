import type { Command } from 'commander';
import type { LineageReport } from '@memnox/sdk';
import type { CliContext } from '../cli-context';
import { DEFAULT_BASE_URL } from '../defaults';

const EXIT_INVALID_SESSION = 1;

export function registerReplayCommand(program: Command, context: CliContext): void {
  program
    .command('replay <sessionId>')
    .description('Replay every decision in one agent session, in order')
    .option('--url <url>', `runtime base URL (default: ${DEFAULT_BASE_URL})`)
    .option('--admin-token <token>', 'admin token if the runtime requires one')
    .action(async (sessionId: string, options: { url?: string; adminToken?: string }) => {
      // An empty id matches every event whose session was never stamped, which
      // reads as "this session did all of it" — the whole trail under one label.
      if (sessionId.trim() === '') {
        context.out.line('A session id is required — see one with "memnox audit".');
        process.exitCode = EXIT_INVALID_SESSION;
        return;
      }
      const { client } = await context.connect(options);
      const events = await client.queryAudit({ sessionId });
      if (events.length === 0) {
        context.out.line(`No audited actions for session ${sessionId}.`);
        return;
      }
      context.out.line(`Session ${sessionId} — ${events.length} action(s):\n`);
      for (const event of events) {
        const target = event.target ? ` ${event.target}` : '';
        const env = event.environment ? ` [${event.environment}]` : '';
        const advisories =
          event.advisories.length > 0 ? `  signals: ${event.advisories.join(', ')}` : '';
        context.out.line(
          `${event.occurredAt}  ${event.effect.toUpperCase().padEnd(16)} ${event.action}${target}${env} — ${event.reason}${advisories}`,
        );
      }

      await renderLineage(context, client, sessionId);
    });
}

/**
 * Who caused this. Every hop states its method: an inferred hop pretending to be a
 * propagated one is worse than a gap, so the weakest link is what the chain reports.
 */
async function renderLineage(
  context: CliContext,
  client: { lineage: (id: string) => Promise<LineageReport> },
  sessionId: string,
): Promise<void> {
  const { out, style } = context;
  let report: LineageReport;
  try {
    report = await client.lineage(sessionId);
  } catch {
    // A runtime one version behind serves no lineage; that is a gap, not a crash.
    return;
  }
  if (report.lineage.hops.length === 0) return;

  out.line('');
  out.line(style.bold('LINEAGE'));
  for (const hop of report.lineage.hops) {
    const ref = hop.ref === undefined ? '' : ` ${hop.ref}`;
    out.line(
      `  ${hop.at}  ${hop.actorKind}:${hop.actorId}  ${hop.system}${ref}  ${style.dim(hop.method)}`,
    );
  }
  out.line(
    style.dim(
      `  confidence ${report.confidence} — a chain is only as good as its weakest hop`,
    ),
  );
  for (const gap of report.unjoined) {
    out.line(style.dim(`  not joined to a verdict: ${gap}`));
  }
}
