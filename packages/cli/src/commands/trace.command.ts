import type { Command } from 'commander';
import type { ActionEvent, DecisionEffect } from '@memnox/core';
import { DECISION_EFFECT, ENFORCEMENT_MODE } from '@memnox/core';
import type { CliContext } from '../cli-context';
import { DEFAULT_BASE_URL } from '../defaults';

const EXIT_NOT_FOUND = 1;
/** How far back an id is looked for; the audit route has no by-id filter. */
const DEFAULT_TRACE_WINDOW = 500;
const STEP_WIDTH = 12;
const ARROW = '       ↓';
const HASH_PREVIEW = 12;

const VERDICT_LABEL: Record<DecisionEffect, string> = {
  [DECISION_EFFECT.ALLOW]: 'ALLOW',
  [DECISION_EFFECT.WITHHOLD]: 'BLOCK',
  [DECISION_EFFECT.ESCALATE]: 'REQUIRE APPROVAL',
};

/** Deterministic and offline, unlike `explain` — this is the record, not a reading of it. */
export function registerTraceCommand(program: Command, context: CliContext): void {
  program
    .command('trace [eventId]')
    .description(
      'The evidence behind one recorded decision, link by link (defaults to the most recent)',
    )
    .option(
      '--window <count>',
      `how many recent events to search (default: ${DEFAULT_TRACE_WINDOW})`,
      String(DEFAULT_TRACE_WINDOW),
    )
    .option('--json', 'emit the chain as JSON instead of the report')
    .option('--url <url>', `runtime base URL (default: ${DEFAULT_BASE_URL})`)
    .option('--admin-token <token>', 'admin token if the runtime requires one')
    .action(
      async (
        eventId: string | undefined,
        options: {
          window: string;
          json?: boolean;
          url?: string;
          adminToken?: string;
        },
      ) => {
        const { out, style } = context;
        const { client } = await context.connect(options);
        const window = Number(options.window);
        if (!Number.isFinite(window) || window <= 0) {
          throw new Error('--window must be a positive number of events');
        }

        // recentAudit answers newest first, so the head is the latest decision.
        const events = await client.recentAudit(window);
        // Outcome events carry decisionEventId, so a decision is never traced to itself.
        const decisions = events.filter((event) => event.decisionEventId === undefined);
        const event =
          eventId === undefined
            ? decisions[0]
            : decisions.find((candidate) => candidate.id === eventId);

        if (event === undefined) {
          out.line(
            eventId === undefined
              ? 'The audit log holds no decisions — nothing to trace.'
              : `No decision "${eventId}" in the last ${window} events. Widen it with --window.`,
          );
          process.exitCode = EXIT_NOT_FOUND;
          return;
        }

        const outcome = events.find(
          (candidate) => candidate.decisionEventId === event.id,
        );

        if (options.json === true) {
          out.line(
            JSON.stringify({ decision: event, outcome: outcome ?? null }, null, 2),
          );
          return;
        }

        out.line(`${style.bold('MEMNOX TRACE')}  ${event.id}`);
        out.line('');
        reportChain(context, event, outcome);
        out.line('');
        reportEvidence(context, event, outcome);
        out.note('');
        out.note(
          style.dim(`→ The whole run:  memnox replay ${event.sessionId ?? '<session>'}`),
        );
        out.note(style.dim(`→ In plain language:  memnox explain ${event.id}`));
      },
    );
}

function reportChain(
  context: CliContext,
  event: ActionEvent,
  outcome: ActionEvent | undefined,
): void {
  const { out, style } = context;
  const subject = [event.action, event.target].filter(Boolean).join(' ');
  const scope = event.environment === undefined ? '' : ` [${event.environment}]`;

  step(context, 'Requested', `${style.bold(subject)}${scope}`);
  detail(
    context,
    `by ${event.agentName} (${event.agentId})` +
      (event.principal === undefined ? '' : ` on behalf of ${event.principal}`),
  );
  detail(context, `at ${event.occurredAt}`);

  arrow(context);
  step(context, 'Risk', style.risk(event.riskLevel, event.riskLevel));

  arrow(context);
  step(
    context,
    'Rules',
    event.matchedPolicies.length > 0
      ? event.matchedPolicies.join(', ')
      : style.dim('none matched — nobody has ruled on this action'),
  );

  if (event.advisories.length > 0) {
    arrow(context);
    step(context, 'Signals', event.advisories.join(', '));
  }

  if (event.taint !== undefined && event.taint.tainted) {
    arrow(context);
    step(
      context,
      'Provenance',
      `influenced by ${event.taint.sources.map((source) => source.sourceType).join(', ')}`,
    );
  }

  arrow(context);
  step(
    context,
    'Decision',
    style.effect(event.effect, style.bold(VERDICT_LABEL[event.effect])),
  );
  detail(context, event.reason);
  if (event.shadowEffect !== undefined) {
    detail(
      context,
      style.warn(
        `shadow: enforce would have said ${event.shadowEffect}, but ${event.environment ?? 'this environment'} is in ${event.enforcementMode ?? ENFORCEMENT_MODE.OBSERVE} mode`,
      ),
    );
  }

  if (event.approvers !== undefined && event.approvers.length > 0) {
    arrow(context);
    step(context, 'Asked', event.approvers.join(', '));
  }

  arrow(context);
  step(context, 'Outcome', describeOutcome(context, event, outcome));
}

function describeOutcome(
  context: CliContext,
  event: ActionEvent,
  outcome: ActionEvent | undefined,
): string {
  const { style } = context;
  if (outcome === undefined) {
    return event.effect === DECISION_EFFECT.ALLOW
      ? style.dim('allowed, but the caller reported no outcome — no testimony either way')
      : style.dim('the action did not proceed');
  }
  if (outcome.defiedVerdict === true) {
    return style.warn('the agent reported acting on a decision that did not allow it');
  }
  const rollback =
    outcome.rollbackFailed === true
      ? ' — rollback failed, the resulting state is unknown'
      : outcome.rolledBack === true
        ? ' — rolled back'
        : '';
  return `${outcome.executionStatus ?? 'reported'}${rollback}`;
}

/** Only what the record actually carries is ticked; the rest is named as absent. */
function reportEvidence(
  context: CliContext,
  event: ActionEvent,
  outcome: ActionEvent | undefined,
): void {
  const { out, style } = context;
  out.line(style.bold('Evidence'));
  mark(
    context,
    event.agentId.length > 0,
    'agent identity',
    `${event.agentName} (${event.agentId})`,
  );
  mark(
    context,
    event.principal !== undefined,
    'human principal',
    event.principal ?? 'not stated by the caller',
  );
  mark(
    context,
    event.matchedPolicies.length > 0,
    'declared rule',
    event.matchedPolicies.join(', ') || 'no rule covers this action',
  );
  mark(
    context,
    event.policyVersion !== undefined,
    'rule set version',
    event.policyVersion ?? 'not stamped',
  );
  mark(
    context,
    event.hash !== undefined,
    'tamper evidence',
    event.hash === undefined
      ? 'this event is not chained'
      : `chained — ${short(event.prevHash)} → ${short(event.hash)}`,
  );
  mark(
    context,
    outcome !== undefined,
    'reported outcome',
    outcome === undefined ? 'never reported' : outcome.id,
  );
}

function mark(context: CliContext, present: boolean, label: string, value: string): void {
  const { out, style } = context;
  const symbol = present ? style.ok('✓') : style.dim('·');
  const body = present ? value : style.dim(value);
  out.line(`  ${symbol} ${label.padEnd(18)}${body}`);
}

const short = (hash: string | undefined): string =>
  hash === undefined ? 'genesis' : `${hash.slice(0, HASH_PREVIEW)}…`;

function step(context: CliContext, name: string, value: string): void {
  context.out.line(`  ${context.style.dim(name.padEnd(STEP_WIDTH))}${value}`);
}

function detail(context: CliContext, value: string): void {
  context.out.line(`  ${''.padEnd(STEP_WIDTH)}${value}`);
}

function arrow(context: CliContext): void {
  context.out.line(context.style.dim(ARROW));
}
