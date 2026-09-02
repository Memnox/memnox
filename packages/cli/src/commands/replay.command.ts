import type { Command } from 'commander';
import type { ActionEvent } from '@memnox/core';
import { DECISION_EFFECT, EXECUTION_STATUS } from '@memnox/core';
import type { LineageReport, MemnoxClient, ObservedFrame } from '@memnox/sdk';
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

      await renderTimeline(context, client, sessionId);
      renderClaimAgainstRecord(context, events);
      await renderLineage(context, client, sessionId);
    });
}

const TIME_WIDTH = 7;
const KIND_WIDTH = 10;

/**
 * One session, one timeline, assembled from what was intercepted rather than from a
 * transcript. Every row is something a seam observed, which is the whole difference
 * between a history and the agent's account of itself.
 */
async function renderTimeline(
  context: CliContext,
  client: Pick<MemnoxClient, 'sessionFrames'>,
  sessionId: string,
): Promise<void> {
  const { out, style } = context;
  let frames: ObservedFrame[];
  try {
    frames = await client.sessionFrames(sessionId);
  } catch {
    // A runtime that keeps no frames serves none; that is a gap, not a crash.
    return;
  }
  if (frames.length === 0) return;

  out.line('');
  out.line(style.bold('OBSERVED AT THE SEAMS'));
  out.line('');
  for (const frame of frames) {
    const at = frame.at.slice(11, 16).padEnd(TIME_WIDTH);
    out.line(`  ${at}${frame.kind.padEnd(KIND_WIDTH)}${frame.summary}`);
  }
}

/**
 * "I completed everything successfully" is generated text. Where the agent's own report
 * disagrees with what the seam recorded, the seam wins — and that disagreement is the
 * single most useful line in the session.
 */
function renderClaimAgainstRecord(
  context: CliContext,
  events: readonly ActionEvent[],
): void {
  const { out, style } = context;
  const defied = events.filter((event) => event.defiedVerdict === true);
  const withheld = events.filter(
    (event) => event.effect === DECISION_EFFECT.WITHHOLD,
  ).length;
  // Every way an execution can end badly: a precondition, the action, a postcondition.
  const failed = events.filter(
    (event) =>
      event.executionStatus !== undefined &&
      event.executionStatus !== EXECUTION_STATUS.SUCCEEDED,
  ).length;
  if (defied.length === 0 && withheld === 0 && failed === 0) return;

  out.line('');
  out.line(style.bold('THE CLAIM AGAINST THE RECORD'));
  out.line('');
  if (withheld > 0) {
    out.line(
      `  ${style.warn('✕')}  ${withheld} action(s) withheld — the work stopped there`,
    );
  }
  if (failed > 0) {
    out.line(`  ${style.warn('✕')}  ${failed} action(s) reported as failed`);
  }
  for (const event of defied) {
    // The agent said it worked; the gate says it never had permission to try.
    out.line(
      `  ${style.warn('✕')}  claimed success on ${event.action}, which was not allowed`,
    );
  }
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
