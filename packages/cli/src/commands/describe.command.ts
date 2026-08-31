import type { Command } from 'commander';
import type { ActionEvent, DecisionEffect, RiskAssessment } from '@memnox/core';
import { DECISION_EFFECT } from '@memnox/core';
import type { DecisionRecordResponse } from '@memnox/sdk';
import type { CliContext } from '../cli-context';
import { DEFAULT_BASE_URL } from '../defaults';
import { isEmptyReach, policyReach, reachBeyond } from '../policy-reach';
import { resolveProjectId } from '../project-identity';

/** How far back "observed" looks. Fixed, so two runs an hour apart are comparable. */
const HISTORY_WINDOW = 200;
const MAX_LISTED_DECISIONS = 5;
const LABEL_WIDTH = 8;

const VERDICT_LABEL: Record<DecisionEffect, string> = {
  [DECISION_EFFECT.ALLOW]: 'ALLOW',
  [DECISION_EFFECT.WITHHOLD]: 'WITHHOLD',
  [DECISION_EFFECT.ESCALATE]: 'ESCALATE',
};

const EFFECT_VERB: Record<DecisionEffect, string> = {
  [DECISION_EFFECT.ALLOW]: 'allows',
  [DECISION_EFFECT.WITHHOLD]: 'withholds',
  [DECISION_EFFECT.ESCALATE]: 'requires approval',
};

/** Where the command is being run; injected so tests never depend on the real cwd. */
type WorkingDirectory = () => string;

/** What an action reaches, in the organization's terms: rules, decisions, people, history. */
export function registerDescribeCommand(
  program: Command,
  context: CliContext,
  cwd: WorkingDirectory = () => process.cwd(),
): void {
  program
    .command('describe <action> [target]')
    .description(
      'Everything your organization attaches to one action, and what else it reaches',
    )
    .option('--env <environment>', 'environment, e.g. production')
    .option(
      '--project <name>',
      'governance scope (default: the project this directory declares)',
    )
    .option('--token <token>', `agent token (default: the one from "memnox setup")`)
    .option('--admin-token <token>', 'admin token, to read decisions and the rule set')
    .option('--json', 'emit the structured briefing instead of the report')
    .option('--url <url>', `runtime base URL (default: ${DEFAULT_BASE_URL})`)
    .action(
      async (
        action: string,
        target: string | undefined,
        options: {
          env?: string;
          project?: string;
          token?: string;
          adminToken?: string;
          json?: boolean;
          url?: string;
        },
      ) => {
        const { out, style } = context;
        const { client, connection } = await context.connect(options);
        if (connection.token === undefined) {
          throw new Error(
            'No agent token. Pass --token, export MEMNOX_AGENT_TOKEN, or run "memnox setup" to store one.',
          );
        }

        const request = {
          action,
          ...(target === undefined ? {} : { target }),
          ...(options.env === undefined ? {} : { environment: options.env }),
          ...(() => {
            const projectId = options.project ?? resolveProjectId(cwd());
            return projectId === undefined ? {} : { projectId };
          })(),
        };

        // Read-only throughout: nothing here decides, records, or raises an approval.
        const assessment = await client.evaluateRisk(request);
        const ruleSet = await readable(context, 'the rule set', () => client.policies());
        const decisions = await readable(context, 'decision memory', () =>
          client.searchDecisions([action, target].filter(Boolean).join(' ')),
        );
        const history = await readable(context, 'the audit trail', () =>
          client.recentAudit(HISTORY_WINDOW),
        );

        if (options.json === true) {
          out.line(
            JSON.stringify(
              {
                request,
                assessment,
                decisions: decisions ?? [],
                observed: summarize(history ?? [], action),
              },
              null,
              2,
            ),
          );
          return;
        }

        const subject = [action, target].filter(Boolean).join(' ');
        const scope = options.env === undefined ? '' : ` [${options.env}]`;
        out.line(style.bold('MEMNOX IMPACT'));
        out.line('');
        out.line(`  ${style.bold(subject)}${scope}`);
        out.line('');

        reportVerdict(context, assessment);
        reportGovernance(context, assessment, ruleSet?.policies ?? [], request);
        reportApprovers(context, assessment);
        reportDecisions(context, decisions ?? []);
        reportObserved(context, history ?? [], action);

        out.note('');
        out.note(style.dim(`→ Ask for a real decision:  memnox check ${action}`));
      },
    );
}

function reportVerdict(context: CliContext, assessment: RiskAssessment): void {
  const { out, style } = context;
  out.line(style.bold('Verdict now'));
  out.line(
    `  ${style.effect(assessment.effect, style.bold(VERDICT_LABEL[assessment.effect]))}` +
      `  ${style.dim('risk')} ${style.risk(assessment.riskLevel, assessment.riskLevel)}` +
      `  ${style.dim('agent trust')} ${assessment.trustScore}/100`,
  );
  out.line(`  ${assessment.reason}`);
  out.line('');
}

/** The blast radius Memnox can honestly compute: how far the matched rules reach. */
function reportGovernance(
  context: CliContext,
  assessment: RiskAssessment,
  policies: readonly unknown[],
  request: { action: string; target?: string; environment?: string },
): void {
  const { out, style } = context;
  out.line(style.bold('Governed by'));
  if (assessment.matchedPolicies.length === 0 && assessment.advisories.length === 0) {
    out.line(
      `  ${style.warn('nothing')} — no rule your organization wrote covers this action.`,
    );
    out.line(style.dim('  That means nobody has ruled on it, not that it is safe.'));
    out.line('');
    return;
  }

  for (const policy of assessment.matchedPolicies) {
    const observed =
      policy.observed === true ? ' (observed — records, does not decide)' : '';
    out.line(
      `  ${label('policy')}${policy.name} — ${EFFECT_VERB[policy.effect]}${observed}`,
    );
    if (policy.reason !== undefined)
      out.line(style.dim(`  ${''.padEnd(LABEL_WIDTH)}${policy.reason}`));
    reportReach(context, policies, policy.name, request);
  }
  for (const advisory of assessment.advisories) {
    const effect =
      advisory.escalateTo === undefined
        ? 'signal only'
        : EFFECT_VERB[advisory.escalateTo];
    out.line(`  ${label('signal')}${advisory.source} — ${effect}`);
    out.line(style.dim(`  ${''.padEnd(LABEL_WIDTH)}${advisory.reason}`));
  }
  out.line('');
}

function reportReach(
  context: CliContext,
  policies: readonly unknown[],
  name: string,
  request: { action: string; target?: string; environment?: string },
): void {
  const reach = policyReach(policies, name);
  if (reach === null) return;
  const beyond = reachBeyond(reach, request);
  if (isEmptyReach(beyond)) return;

  const parts = [
    beyond.actions.length > 0 ? beyond.actions.join(', ') : undefined,
    beyond.targets.length > 0 ? `on ${beyond.targets.join(', ')}` : undefined,
    beyond.environments.length > 0 ? `in ${beyond.environments.join(', ')}` : undefined,
  ].filter(Boolean);
  context.out.line(
    context.style.dim(`  ${''.padEnd(LABEL_WIDTH)}also governs ${parts.join(' ')}`),
  );
}

function reportApprovers(context: CliContext, assessment: RiskAssessment): void {
  const { out, style } = context;
  const approvers: string[] = [];
  for (const source of [...assessment.matchedPolicies, ...assessment.advisories]) {
    for (const approver of source.approvers ?? []) {
      if (!approvers.includes(approver)) approvers.push(approver);
    }
  }
  if (approvers.length === 0) return;
  out.line(style.bold('Who can authorise it'));
  out.line(`  ${approvers.join(', ')}`);
  out.line('');
}

function reportDecisions(
  context: CliContext,
  decisions: readonly DecisionRecordResponse[],
): void {
  const { out, style } = context;
  if (decisions.length === 0) return;
  out.line(style.bold('Decisions on record'));
  for (const decision of decisions.slice(0, MAX_LISTED_DECISIONS)) {
    out.line(`  ${decision.id}  ${decision.title}`);
    out.line(
      style.dim(`  ${''.padEnd(LABEL_WIDTH)}${decision.owner} — ${decision.statement}`),
    );
  }
  if (decisions.length > MAX_LISTED_DECISIONS) {
    out.line(
      style.dim(
        `  ${''.padEnd(LABEL_WIDTH)}and ${decisions.length - MAX_LISTED_DECISIONS} more`,
      ),
    );
  }
  out.line('');
}

interface ObservedSummary {
  window: number;
  matched: number;
  withheld: number;
  held: number;
  allowed: number;
  lastSeen?: string;
  lastAgent?: string;
}

function summarize(events: readonly ActionEvent[], action: string): ObservedSummary {
  const matched = events.filter((event) => event.action === action);
  // recentAudit answers newest first, so the head is the most recent sighting.
  const last = matched[0];
  return {
    window: events.length,
    matched: matched.length,
    withheld: matched.filter((e) => e.effect === DECISION_EFFECT.WITHHOLD).length,
    held: matched.filter((e) => e.effect === DECISION_EFFECT.ESCALATE).length,
    allowed: matched.filter((e) => e.effect === DECISION_EFFECT.ALLOW).length,
    ...(last === undefined
      ? {}
      : { lastSeen: last.occurredAt, lastAgent: last.agentName }),
  };
}

function reportObserved(
  context: CliContext,
  events: readonly ActionEvent[],
  action: string,
): void {
  const { out, style } = context;
  const observed = summarize(events, action);
  out.line(style.bold('Observed'));
  if (observed.matched === 0) {
    out.line(
      `  never, in the last ${observed.window} audited actions — this would be the first`,
    );
    out.line('');
    return;
  }
  out.line(
    `  ${observed.matched} of the last ${observed.window} audited actions — ` +
      `${observed.withheld} withheld, ${observed.held} held, ${observed.allowed} allowed`,
  );
  if (observed.lastSeen !== undefined) {
    out.line(style.dim(`  last ${observed.lastSeen} by ${observed.lastAgent}`));
  }
  out.line('');
}

const label = (text: string): string => text.padEnd(LABEL_WIDTH);

/** The admin surfaces are optional here: a missing one narrows the report, never fails it. */
async function readable<T>(
  context: CliContext,
  what: string,
  read: () => Promise<T>,
): Promise<T | null> {
  try {
    return await read();
  } catch (err) {
    context.out.note(`Could not read ${what}: ${String(err)}`);
    return null;
  }
}
