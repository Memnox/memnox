import type { Command } from 'commander';
import type { ActionEvent, ActionRequest, DecisionEffect, RiskLevel } from '@memnox/core';
import { DECISION_EFFECT } from '@memnox/core';
import type { CliContext } from '../cli-context';
import { loadActionPlan } from '../action-plan-file';
import { DEFAULT_BASE_URL } from '../defaults';
import { resolveProjectId } from '../project-identity';

/** The same codes `memnox check` uses, so one pipeline can branch on either. */
export const EXIT_PLAN_APPROVAL = 2;
export const EXIT_PLAN_WITHHELD = 3;

const VERDICT_WIDTH = 9;

const VERDICT_LABEL: Record<DecisionEffect, string> = {
  [DECISION_EFFECT.ALLOW]: 'allow',
  [DECISION_EFFECT.WITHHOLD]: 'withhold',
  [DECISION_EFFECT.ESCALATE]: 'approval',
};

interface PlannedAction {
  request: ActionRequest;
  effect: DecisionEffect;
  riskLevel: RiskLevel;
  reason: string;
  matchedPolicies: string[];
}

/** Where the command is being run; injected so tests never depend on the real cwd. */
type WorkingDirectory = () => string;

/** Everything an agent means to do, ruled on together, before any of it happens. */
export function registerPlanCommand(
  program: Command,
  context: CliContext,
  cwd: WorkingDirectory = () => process.cwd(),
): void {
  program
    .command('plan [file]')
    .description(
      `Rule on a whole run before it starts — nothing is recorded (exit ${EXIT_PLAN_APPROVAL} = needs approval, ${EXIT_PLAN_WITHHELD} = withheld)`,
    )
    .option('--from-session <id>', 'plan the actions an audited session already took')
    .option('--env <environment>', 'environment for entries that do not name one')
    .option(
      '--project <name>',
      'governance scope (default: the project this directory declares)',
    )
    .option('--token <token>', `agent token (default: the one from "memnox setup")`)
    .option('--admin-token <token>', 'admin token, needed only with --from-session')
    .option('--json', 'emit the planned verdicts as JSON instead of the report')
    .option('--url <url>', `runtime base URL (default: ${DEFAULT_BASE_URL})`)
    .action(
      async (
        file: string | undefined,
        options: {
          fromSession?: string;
          env?: string;
          project?: string;
          token?: string;
          adminToken?: string;
          json?: boolean;
          url?: string;
        },
      ) => {
        const { out, style } = context;
        if (file === undefined && options.fromSession === undefined) {
          throw new Error(
            'Plan what? Pass a plan file, or --from-session <id> to plan a session already on record.',
          );
        }

        const { client, connection } = await context.connect(options);
        if (connection.token === undefined) {
          throw new Error(
            'No agent token. Pass --token, export MEMNOX_AGENT_TOKEN, or run "memnox setup" to store one.',
          );
        }

        const requests =
          file === undefined
            ? fromSession(await client.queryAudit({ sessionId: options.fromSession }))
            : (await loadActionPlan(file)).actions;

        if (requests.length === 0) {
          out.line('Nothing to plan — the plan names no actions.');
          return;
        }

        const projectId = options.project ?? resolveProjectId(cwd());
        const planned: PlannedAction[] = [];
        // Sequential: the evaluate route is per-agent rate limited, and a burst
        // would report 429s as verdicts.
        for (const request of requests) {
          const full = {
            ...request,
            ...(request.environment === undefined && options.env !== undefined
              ? { environment: options.env }
              : {}),
            ...(request.projectId === undefined && projectId !== undefined
              ? { projectId }
              : {}),
          };
          const assessment = await client.evaluateRisk(full);
          planned.push({
            request: full,
            effect: assessment.effect,
            riskLevel: assessment.riskLevel,
            reason: assessment.reason,
            matchedPolicies: assessment.matchedPolicies.map((policy) => policy.name),
          });
        }

        if (options.json === true) {
          out.line(JSON.stringify({ planned }, null, 2));
          process.exitCode = exitCodeFor(planned);
          return;
        }

        out.line(style.bold(`Memnox plan — ${planned.length} action(s)`));
        out.line('');
        for (const action of planned) reportAction(context, action);
        out.line('');
        out.line(style.bold(tally(planned)));
        out.line(
          style.dim(
            'Nothing was done and nothing was recorded — this is what would happen.',
          ),
        );
        reportNextStep(context, planned);

        process.exitCode = exitCodeFor(planned);
      },
    );
}

/** Real history makes a far better plan than an invented one. */
function fromSession(events: readonly ActionEvent[]): ActionRequest[] {
  return events
    .filter((event) => event.decisionEventId === undefined)
    .map((event) => ({
      action: event.action,
      ...(event.target === undefined ? {} : { target: event.target }),
      ...(event.environment === undefined ? {} : { environment: event.environment }),
      ...(event.principal === undefined ? {} : { principal: event.principal }),
      ...(event.projectId === undefined ? {} : { projectId: event.projectId }),
    }));
}

function reportAction(context: CliContext, action: PlannedAction): void {
  const { out, style } = context;
  const symbol = style.symbol(action.effect);
  const verdict = style.effect(
    action.effect,
    VERDICT_LABEL[action.effect].padEnd(VERDICT_WIDTH),
  );
  const subject = [action.request.action, action.request.target]
    .filter(Boolean)
    .join(' ');
  const scope =
    action.request.environment === undefined ? '' : ` [${action.request.environment}]`;
  out.line(
    `  ${symbol === '' ? ' ' : symbol} ${verdict} ${subject}${scope}`.replace(/\s+$/, ''),
  );
  if (action.effect === DECISION_EFFECT.ALLOW) return;
  // Only a stopped action owes the reader a reason; an allow that explains
  // itself buries the three lines that matter.
  const because =
    action.matchedPolicies.length > 0
      ? `${action.reason} [${action.matchedPolicies.join(', ')}]`
      : action.reason;
  out.line(style.dim(`              ${because}`));
}

function tally(planned: readonly PlannedAction[]): string {
  const allow = planned.filter((a) => a.effect === DECISION_EFFECT.ALLOW).length;
  const approval = planned.filter((a) => a.effect === DECISION_EFFECT.ESCALATE).length;
  const withheld = planned.filter((a) => a.effect === DECISION_EFFECT.WITHHOLD).length;
  const parts = [
    `${allow} to allow`,
    `${approval} needing approval`,
    `${withheld} withheld`,
  ];
  return `Plan: ${parts.join(', ')}.`;
}

function exitCodeFor(planned: readonly PlannedAction[]): number {
  if (planned.some((a) => a.effect === DECISION_EFFECT.WITHHOLD))
    return EXIT_PLAN_WITHHELD;
  if (planned.some((a) => a.effect === DECISION_EFFECT.ESCALATE)) {
    return EXIT_PLAN_APPROVAL;
  }
  return 0;
}

function reportNextStep(context: CliContext, planned: readonly PlannedAction[]): void {
  const { out, style } = context;
  const stopped = planned.find((a) => a.effect !== DECISION_EFFECT.ALLOW);
  if (stopped === undefined) return;
  const subject = [stopped.request.action, stopped.request.target]
    .filter(Boolean)
    .map((part) => (String(part).includes(' ') ? `"${String(part)}"` : String(part)))
    .join(' ');
  out.note('');
  out.note(style.dim(`→ Why that one:  memnox describe ${subject}`));
}
