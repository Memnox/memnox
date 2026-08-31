import type { Command } from 'commander';
import type {
  ActionEvent,
  DecisionEffect,
  ExplanationEvidence,
  ExplanationLine,
} from '@memnox/core';
import { DECISION_EFFECT, ENFORCEMENT_MODE, EXPLANATION_EVIDENCE } from '@memnox/core';
import { homedir } from 'node:os';
import { discover, NodeMachineReader, type MachineReader } from '@memnox/discovery';
import { computeCounterfactual } from '@memnox/ledger';
import type { CliContext } from '../cli-context';
import { DEFAULT_BASE_URL } from '../defaults';

const EXIT_NOT_FOUND = 1;
const NUMBER_WIDTH = 3;
/** How far back an id is looked for; the audit route has no by-id filter. */
const DEFAULT_EVIDENCE_WINDOW = 500;
const STEP_WIDTH = 12;
const ARROW = '       \u2193';
const HASH_PREVIEW = 12;

const VERDICT_LABEL: Record<DecisionEffect, string> = {
  [DECISION_EFFECT.ALLOW]: 'ALLOW',
  [DECISION_EFFECT.WITHHOLD]: 'WITHHOLD',
  [DECISION_EFFECT.ESCALATE]: 'ESCALATE',
};

/**
 * Two readings of one decision, both off the record and neither generated. Five lines
 * by default; `--evidence` walks the chain link by link. An explanation produced after
 * the fact by a model is a plausible story about a decision, which is worse than none.
 */
export function registerWhyCommand(program: Command, context: CliContext): void {
  program
    .command('why [decisionId]')
    .description(
      'Why one decision came out the way it did, in five lines from the record',
    )
    .option('--evidence', 'the full chain behind it, link by link, and what is missing')
    .option(
      '--counterfactual',
      'what the withheld action would have reached, from this machine',
    )
    .option(
      '--window <count>',
      `how many recent events to search with --evidence (default: ${DEFAULT_EVIDENCE_WINDOW})`,
      String(DEFAULT_EVIDENCE_WINDOW),
    )
    .option('--json', 'emit the record as JSON')
    .option('--url <url>', `runtime base URL (default: ${DEFAULT_BASE_URL})`)
    .option('--admin-token <token>', 'admin token if the runtime requires one')
    .action(
      async (
        decisionId: string | undefined,
        options: {
          evidence?: boolean;
          counterfactual?: boolean;
          window: string;
          json?: boolean;
          url?: string;
          adminToken?: string;
        },
      ) => {
        if (options.evidence === true) {
          await renderEvidence(context, decisionId, options);
          return;
        }
        if (decisionId === undefined) {
          throw new Error(
            'which decision? Pass an id, or use --evidence for the latest.',
          );
        }
        await renderWhy(context, decisionId, options);
        if (options.counterfactual === true) {
          await renderCounterfactual(context, decisionId, options);
        }
      },
    );
}

/**
 * Derived from the attempt that was actually made and from nothing else. It runs here
 * rather than in the runtime because reachability is this machine's own fact, and a
 * counterfactual that imagined a wider blast radius would be an estimated loss figure
 * in another costume.
 */
async function renderCounterfactual(
  context: CliContext,
  decisionId: string,
  options: { url?: string; adminToken?: string },
  buildReader: () => MachineReader = () => new NodeMachineReader(homedir()),
): Promise<void> {
  const { out, style } = context;
  const { client } = await context.connect(options);
  const events = await client.queryAudit({ limit: DEFAULT_EVIDENCE_WINDOW });
  const decision = events.find((each) => each.id === decisionId);
  if (decision === undefined) {
    out.note(`no audited action by that id in the last ${DEFAULT_EVIDENCE_WINDOW}`);
    return;
  }

  const report = await discover(buildReader(), { now: new Date().toISOString() });
  const counterfactual = computeCounterfactual({
    decisionId,
    action: decision.action,
    ...(decision.target === undefined ? {} : { resource: decision.target }),
    reachable: report.resources.map((resource) => ({
      id: resource.id,
      kind: resource.kind,
      ...(resource.path === undefined ? {} : { path: resource.path }),
    })),
  });

  out.line('');
  out.line(style.bold('WOULD HAVE REACHED'));
  if (counterfactual.wouldHaveReached.length === 0) {
    // Honest when empty: nothing on this machine matches what the attempt named.
    out.line(`  ${style.dim('nothing this machine knows about')}`);
  }
  for (const resource of counterfactual.wouldHaveReached) {
    out.line(`  ${resource.kind}  ${resource.path ?? resource.id}`);
  }
  out.line(style.dim(`  basis: ${counterfactual.basis}`));
}

async function renderWhy(
  context: CliContext,
  decisionId: string,
  options: { json?: boolean; url?: string; adminToken?: string },
): Promise<void> {
  const { out, style } = context;
  const { client } = await context.connect(options);
  const explanation = await client.why(decisionId);
  if (explanation === null) {
    out.note(`no explanation recorded for "${decisionId}"`);
    process.exitCode = EXIT_NOT_FOUND;
    return;
  }

  if (options.json === true) {
    out.line(JSON.stringify(explanation, null, 2));
    return;
  }

  out.line(style.bold(`WHY  ${explanation.decisionId}`));
  out.line('');
  explanation.lines.forEach((line: ExplanationLine, index: number) => {
    out.line(`  ${String(index + 1).padStart(NUMBER_WIDTH)}  ${line.claim}`);
    out.line(`       ${style.dim(citation(line.evidence))}`);
  });
  out.note('');
  out.note(
    style.dim(`\u2192 The whole chain:  memnox why ${explanation.decisionId} --evidence`),
  );
}

async function renderEvidence(
  context: CliContext,
  decisionId: string | undefined,
  options: { window: string; json?: boolean; url?: string; adminToken?: string },
): Promise<void> {
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
    decisionId === undefined
      ? decisions[0]
      : decisions.find((candidate) => candidate.id === decisionId);

  if (event === undefined) {
    out.line(
      decisionId === undefined
        ? 'The audit log holds no decisions \u2014 nothing to show.'
        : `No decision "${decisionId}" in the last ${window} events. Widen it with --window.`,
    );
    process.exitCode = EXIT_NOT_FOUND;
    return;
  }

  const outcome = events.find((candidate) => candidate.decisionEventId === event.id);

  if (options.json === true) {
    out.line(JSON.stringify({ decision: event, outcome: outcome ?? null }, null, 2));
    return;
  }

  out.line(`${style.bold('WHY')}  ${event.id}`);
  out.line('');
  reportChain(context, event, outcome);
  out.line('');
  reportEvidence(context, event, outcome);
  out.note('');
  out.note(
    style.dim(`\u2192 The whole run:  memnox replay ${event.sessionId ?? '<session>'}`),
  );
}

/** Every line traces to the rule version or the context block it came from. */
function citation(evidence: ExplanationEvidence): string {
  if (evidence.kind === EXPLANATION_EVIDENCE.RULE) {
    return `rule ${evidence.rule.id} v${evidence.rule.version}`;
  }
  if (evidence.kind === EXPLANATION_EVIDENCE.CONTEXT) {
    return `context ${evidence.context.source} (${evidence.context.trust})`;
  }
  if (evidence.kind === EXPLANATION_EVIDENCE.SCOPE) {
    return `declared ${evidence.dimension}: ${evidence.declared.join(', ')}`;
  }
  return `request ${evidence.field}=${evidence.value}`;
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
