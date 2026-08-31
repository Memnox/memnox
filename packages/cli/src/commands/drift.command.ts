import type { Command } from 'commander';
import type { ActionEvent, EnvironmentModes } from '@memnox/core';
import { DEFAULT_ENFORCEMENT_MODE, ENFORCEMENT_MODE } from '@memnox/core';
import { FREQUENT_VIOLATION_THRESHOLD } from '@memnox/memory';
import type { DecisionHealthResponse } from '@memnox/sdk';
import type { CliContext } from '../cli-context';
import { DEFAULT_BASE_URL } from '../defaults';

/** Drift is a finding a pipeline should be able to fail on. */
export const EXIT_DRIFT = 1;

/** Fixed window, so two runs a week apart are comparable. */
const DRIFT_WINDOW = 500;
const MAX_LISTED = 8;

interface DriftFinding {
  heading: string;
  lines: string[];
}

/** What the organization says, against what its own trail shows actually happened. */
export function registerDriftCommand(program: Command, context: CliContext): void {
  program
    .command('drift')
    .description(
      `Where your stated rules and your actual history disagree (exit ${EXIT_DRIFT} = drift found)`,
    )
    .option('--json', 'emit the findings as JSON instead of the report')
    .option('--url <url>', `runtime base URL (default: ${DEFAULT_BASE_URL})`)
    .option('--admin-token <token>', 'admin token if the runtime requires one')
    .action(async (options: { json?: boolean; url?: string; adminToken?: string }) => {
      const { out, style } = context;
      const { client } = await context.connect(options);

      const events = await client.recentAudit(DRIFT_WINDOW);
      const modes = await client.enforcement();
      const ruleSet = await client.policies();
      const health = await client.decisionHealth();

      const findings = [
        withheldVerdicts(events, modes),
        unenforcedEnvironments(modes),
        contradictedDecisions(health),
        unexercisedRules(ruleSet.policyNames, events),
        overdueDecisions(health),
      ].filter((finding): finding is DriftFinding => finding !== null);

      if (options.json === true) {
        out.line(JSON.stringify({ window: events.length, findings }, null, 2));
        process.exitCode = findings.length === 0 ? 0 : EXIT_DRIFT;
        return;
      }

      out.line(style.bold('MEMNOX DRIFT'));
      out.line(
        style.dim(
          `What your organization states, against the last ${events.length} audited actions.`,
        ),
      );
      out.line('');

      if (findings.length === 0) {
        out.line(style.ok('No drift — your rules and your history agree.'));
        return;
      }

      for (const finding of findings) {
        out.line(style.warn(finding.heading));
        for (const line of finding.lines) out.line(`  ${line}`);
        out.line('');
      }
      out.note(style.dim('→ Start enforcing:  memnox setup --enforce'));
      out.note(style.dim('→ Retire a stale decision:  memnox memory retire <id>'));

      process.exitCode = EXIT_DRIFT;
    });
}

/** The sharpest drift there is: your policy decided, and the mode let it through anyway. */
function withheldVerdicts(
  events: readonly ActionEvent[],
  modes: EnvironmentModes,
): DriftFinding | null {
  const withheld = events.filter((event) => event.shadowEffect !== undefined);
  if (withheld.length === 0) return null;

  const byAction = new Map<string, number>();
  for (const event of withheld) {
    byAction.set(event.action, (byAction.get(event.action) ?? 0) + 1);
  }
  const environments = [
    ...new Set(withheld.map((event) => event.environment ?? 'unscoped')),
  ];
  return {
    heading: 'Stated but not enforced',
    lines: [
      `${withheld.length} action(s) your rules decided to stop were allowed anyway — ` +
        `the environment is being observed, not enforced.`,
      `Environments: ${environments.join(', ')}` +
        (modes.default === undefined ? '' : ` (default mode: ${modes.default})`),
      ...ranked(byAction).map(([action, count]) => `  ${action} — ${count}`),
    ],
  };
}

function unenforcedEnvironments(modes: EnvironmentModes): DriftFinding | null {
  const named = Object.entries(modes.environments ?? {}).filter(
    ([, mode]) => mode !== ENFORCEMENT_MODE.ENFORCE,
  );
  const fallback = modes.default ?? DEFAULT_ENFORCEMENT_MODE;
  const defaultDrifts = fallback !== ENFORCEMENT_MODE.ENFORCE;
  if (named.length === 0 && !defaultDrifts) return null;

  return {
    heading: 'Rules that cannot decide',
    lines: [
      ...(defaultDrifts
        ? [
            `every environment without its own mode is "${fallback}" — no rule can stop anything`,
          ]
        : []),
      ...named.map(([name, mode]) => `${name} — "${mode}"`),
    ],
  };
}

function contradictedDecisions(health: DecisionHealthResponse): DriftFinding | null {
  const violated = health.entries
    .filter((entry) => entry.violations >= FREQUENT_VIOLATION_THRESHOLD)
    .sort((left, right) => right.violations - left.violations);
  if (violated.length === 0) return null;

  return {
    heading: 'Stated and repeatedly contradicted',
    lines: [
      'Agents keep asking for what these decisions rule out. Either the decision moved on, or something is not getting the message.',
      ...violated
        .slice(0, MAX_LISTED)
        .map((entry) => `  ${entry.id}  ${entry.title} — ${entry.violations} hit(s)`),
    ],
  };
}

/** A rule nothing has ever matched governs nothing, whatever it says it governs. */
function unexercisedRules(
  policyNames: readonly string[],
  events: readonly ActionEvent[],
): DriftFinding | null {
  const exercised = new Set(events.flatMap((event) => event.matchedPolicies));
  const idle = policyNames.filter((name) => !exercised.has(name));
  if (idle.length === 0) return null;

  return {
    heading: 'Stated and never exercised',
    lines: [
      `${idle.length} of ${policyNames.length} rules matched nothing in this window — they may be guarding actions your agents never name.`,
      ...idle.slice(0, MAX_LISTED).map((name) => `  ${name}`),
      ...(idle.length > MAX_LISTED ? [`  and ${idle.length - MAX_LISTED} more`] : []),
    ],
  };
}

function overdueDecisions(health: DecisionHealthResponse): DriftFinding | null {
  const stale = health.entries.filter((entry) => entry.stale);
  if (stale.length === 0) return null;

  return {
    heading: 'Stated a long time ago',
    lines: [
      `${stale.length} active decision(s) are past review and still enforcing (memory health ${health.score}/100).`,
      ...stale
        .slice(0, MAX_LISTED)
        .map(
          (entry) =>
            `  ${entry.id}  ${entry.title}${entry.dueForReview ? ' — review date passed' : ''}`,
        ),
    ],
  };
}

/** Most frequent first, then by name, so two runs over one trail read identically. */
function ranked(counts: Map<string, number>): Array<[string, number]> {
  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, MAX_LISTED);
}
