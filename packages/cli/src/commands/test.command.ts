import { randomUUID } from 'node:crypto';
import type { Command } from 'commander';
import type { DecisionEffect, RiskLevel } from '@memnox/core';
import { DECISION_EFFECT } from '@memnox/core';
import type { CliContext } from '../cli-context';
import { DEFAULT_BASE_URL } from '../defaults';
import { resolveProjectId } from '../project-identity';
import {
  meetsExpectation,
  SAFETY_CASES,
  stopsAction,
  type SafetyCase,
} from '../safety-cases';

/** A gap is a finding, not a crash: 1 is what a test runner returns for failures. */
export const EXIT_UNSAFE = 1;

const VERDICT_WIDTH = 9;
const MARKER_WIDTH = 5;
const DETAIL_INDENT = '        ';
const UNCOVERED = 'no rule your organization wrote covers this';

/** Names the session a recorded run groups under; injected so a test stays stable. */
type SessionIdFactory = () => string;

interface CaseResult {
  safetyCase: SafetyCase;
  effect: DecisionEffect;
  riskLevel: RiskLevel;
  reason: string;
  matchedPolicies: string[];
  passed: boolean;
}

/** Where the command is being run; injected so tests never depend on the real cwd. */
type WorkingDirectory = () => string;

/** The whole suite runs against this machine's rules and this machine's agent token. */
export function registerTestCommand(
  program: Command,
  context: CliContext,
  cwd: WorkingDirectory = () => process.cwd(),
  newSessionId: SessionIdFactory = () => `safety-${randomUUID()}`,
): void {
  program
    .command('test')
    .description(
      `Fire real dangerous actions at your own gate and report what it stops (exit ${EXIT_UNSAFE} = something got through)`,
    )
    .option('--token <token>', `agent token (default: the one from "memnox setup")`)
    .option(
      '--project <name>',
      'governance scope (default: the project this directory declares)',
    )
    .option(
      '--record',
      'decide each case for real, so the run lands in the audit trail (this raises approvals, and the run becomes behaviour the guards can see)',
    )
    .option('--json', 'emit the results as JSON instead of the report')
    .option('--url <url>', `runtime base URL (default: ${DEFAULT_BASE_URL})`)
    .action(
      async (options: {
        token?: string;
        project?: string;
        record?: boolean;
        json?: boolean;
        url?: string;
      }) => {
        const { out, style } = context;
        const { client, connection } = await context.connect(options);
        if (connection.token === undefined) {
          throw new Error(
            'No agent token. Pass --token, export MEMNOX_AGENT_TOKEN, or run "memnox setup" to store one.',
          );
        }

        const projectId = options.project ?? resolveProjectId(cwd());
        const sessionId = options.record === true ? newSessionId() : undefined;
        const results: CaseResult[] = [];

        // Sequential on purpose: the check route is rate limited per agent, and a
        // suite that trips it would report gaps that are really 429s.
        for (const safetyCase of SAFETY_CASES) {
          const request = {
            ...safetyCase.request,
            ...(projectId === undefined ? {} : { projectId }),
            ...(sessionId === undefined ? {} : { sessionId }),
          };
          const outcome =
            sessionId === undefined
              ? await client.evaluateRisk(request)
              : await client.check(request);
          results.push({
            safetyCase,
            effect: outcome.effect,
            riskLevel: outcome.riskLevel,
            reason: outcome.reason,
            matchedPolicies: outcome.matchedPolicies.map((policy) => policy.name),
            passed: meetsExpectation(safetyCase, outcome.effect),
          });
        }

        const gaps = results.filter((result) => !result.passed);

        if (options.json === true) {
          out.line(JSON.stringify({ sessionId, results }, null, 2));
          process.exitCode = gaps.length === 0 ? 0 : EXIT_UNSAFE;
          return;
        }

        out.line(style.bold('MEMNOX AGENT SAFETY TEST'));
        out.line('');
        out.line(`${style.dim('Runtime')}  ${connection.url}`);
        if (projectId !== undefined) out.line(`${style.dim('Project')}  ${projectId}`);
        out.line(
          `${style.dim('Mode')}     ${
            sessionId === undefined
              ? 'evaluated only — nothing was recorded and no action was taken'
              : `recorded as session ${sessionId}`
          }`,
        );
        out.line('');

        for (const result of results) reportCase(context, result);

        out.line('');
        out.line(style.bold('Result'));
        out.line(`  ${results.length} capabilities tested`);
        out.line(`  ${tally(results)}`);
        reportGaps(context, gaps);
        reportNextStep(context, sessionId);

        process.exitCode = gaps.length === 0 ? 0 : EXIT_UNSAFE;
      },
    );
}

function reportCase(context: CliContext, result: CaseResult): void {
  const { out, style } = context;
  const marker = result.passed
    ? style.ok('PASS'.padEnd(MARKER_WIDTH))
    : style.warn('GAP'.padEnd(MARKER_WIDTH));
  const verdict = style.effect(
    result.effect,
    verdictLabel(result.effect).padEnd(VERDICT_WIDTH),
  );
  out.line(`  ${marker} ${verdict} ${result.safetyCase.title}`);

  const subject = [
    result.safetyCase.request.action,
    result.safetyCase.request.target === undefined
      ? undefined
      : `"${result.safetyCase.request.target}"`,
  ]
    .filter(Boolean)
    .join(' ');
  out.line(style.dim(`${DETAIL_INDENT}${subject} — ${because(result)}`));
}

/** A guard can stop an action no rule names, so "uncovered" is only ever said of an allow. */
function because(result: CaseResult): string {
  if (result.matchedPolicies.length > 0) return result.matchedPolicies.join(', ');
  return stopsAction(result.effect) ? result.reason : UNCOVERED;
}

/** The verdict in the reader's terms; "escalate" is not a word. */
function verdictLabel(effect: DecisionEffect): string {
  if (effect === DECISION_EFFECT.WITHHOLD) return 'WITHHELD';
  if (effect === DECISION_EFFECT.ESCALATE) return 'ESCALATED';
  return 'ALLOWED';
}

function tally(results: readonly CaseResult[]): string {
  const withheld = results.filter((r) => r.effect === DECISION_EFFECT.WITHHOLD).length;
  const held = results.filter((r) => r.effect === DECISION_EFFECT.ESCALATE).length;
  const allowed = results.filter((r) => !stopsAction(r.effect)).length;
  return `${withheld} withheld, ${held} held for approval, ${allowed} allowed`;
}

function reportGaps(context: CliContext, gaps: readonly CaseResult[]): void {
  const { out, style } = context;
  if (gaps.length === 0) {
    out.line(style.ok('  Every dangerous capability tested was stopped.'));
    return;
  }
  out.line('');
  out.line(
    style.warn(`  ${gaps.length} of these your agent can do right now, unattended:`),
  );
  for (const gap of gaps) out.line(`    - ${gap.safetyCase.title}`);
}

function reportNextStep(context: CliContext, sessionId: string | undefined): void {
  const { out, style } = context;
  out.note('');
  out.note(style.dim('→ See what governs one:  memnox rules shell.execute "rm -rf /"'));
  if (sessionId !== undefined) {
    out.note(style.dim(`→ Replay the run:        memnox replay ${sessionId}`));
    return;
  }
  out.note(style.dim('→ Leave proof in the trail:  memnox test --record'));
}
