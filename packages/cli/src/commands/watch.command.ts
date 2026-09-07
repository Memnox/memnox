import { homedir } from 'node:os';
import type { Command } from 'commander';
import {
  agentUpdates,
  alertsFor,
  bulkArrivals,
  CHANGE_DIRECTION,
  CHANGE_SUBJECT,
  compareSnapshots,
  describeSkill,
  describeUpdate,
  discoverDefinitions,
  readAcceptedSkills,
  reviewSkills,
  SKILL_STANDING,
  watchablePaths,
  type EnvironmentChange,
  type EnvironmentSnapshot,
  type SkillFinding,
} from '@memnox/core';
import type { CliContext } from '../cli-context';
import type { CredentialFinding, DiscoveryReport } from '@memnox/core';
import {
  defaultScanSeams,
  rulesCovering,
  scanMachine,
  type ScanSeams,
} from '../machine-scan';
import { watchConfigPaths } from '../config-watch';

const DEFAULT_INTERVAL_SECONDS = 60;
const MILLISECONDS = 1_000;

/**
 * The wait between scans, as an argument: a test that actually slept for a minute would
 * not be run. The real one returns early when an agent's configuration changes, so a
 * server added mid-watch is reported in seconds rather than on the next minute.
 */
type Waiter = (milliseconds: number) => Promise<unknown>;

const WATCHING_WAIT = (): { wait: Waiter; close: () => void } => {
  const watcher = watchConfigPaths(watchablePaths(homedir()));
  return {
    wait: (milliseconds) => watcher.next(milliseconds),
    close: () => watcher.close(),
  };
};

/**
 * A forgotten permission stops being invisible risk and becomes something with a date
 * on it. Each cycle rescans, reports what arrived, and keeps the new scan as the next
 * baseline — so stopping and starting the watch never loses a change.
 */
export function registerWatchCommand(
  program: Command,
  context: CliContext,
  buildSeams: (cwd: string) => ScanSeams = defaultScanSeams,
  cwd: () => string = () => process.cwd(),
  waiter: () => { wait: Waiter; close: () => void } = WATCHING_WAIT,
): void {
  program
    .command('watch')
    .description('Keep the inventory current and report what arrives')
    .option(
      '--interval <seconds>',
      'seconds between scans',
      String(DEFAULT_INTERVAL_SECONDS),
    )
    .option('--cycles <n>', 'stop after this many scans instead of running until stopped')
    .option('--json', 'emit one JSON object per cycle')
    .option(
      '--no-probe',
      'do not start MCP servers to ask what they hold; tools go uncounted',
    )
    .action(
      async (options: {
        interval: string;
        cycles?: string;
        json?: boolean;
        probe: boolean;
      }) => {
        const seams = buildSeams(cwd());
        const interval = Number(options.interval);
        if (!Number.isFinite(interval) || interval <= 0) {
          throw new Error('--interval must be a positive number of seconds');
        }
        const cycles = options.cycles === undefined ? Infinity : Number(options.cycles);
        if (!Number.isFinite(cycles) && options.cycles !== undefined) {
          throw new Error('--cycles must be a number');
        }

        // The interval is the backstop, not the mechanism.
        const between = waiter();
        let baseline = await seams.snapshots.latest();
        let previous: DiscoveryReport | null = null;
        /* Definitions are not in the snapshot, so the previous cycle's ids are kept
           here. Null on the first cycle for the same reason the baseline is: a watch
           starting on a machine reports what arrives, never what was already there. */
        let seenDefinitions: Set<string> | null = null;
        for (let cycle = 0; cycle < cycles; cycle += 1) {
          if (cycle > 0) await between.wait(interval * MILLISECONDS);
          const { report: scanned, snapshot } = await scanMachine(seams, {
            probe: options.probe,
          });
          const changes = baseline === null ? [] : compareSnapshots(baseline, snapshot);
          /* A login is a capability arriving, and it leaves no trace in an agent's
             config — so the credential directories are watched in their own right. */
          const logins = baseline === null ? [] : newCredentials(previous, scanned);
          previous = scanned;
          /* An agent that updated itself is reported even when nothing else moved:
             nobody granted the difference, which is what makes it worth saying. */
          const updates = baseline === null ? [] : agentUpdates(baseline, snapshot);
          baseline = snapshot;
          /* An installed definition touches no config the snapshot carries, so this
             is its own pass. Without it the watcher wakes on `~/.claude/agents` — it
             is watched — and reports nothing, which is worse than not watching. */
          const definitions = await reviewDefinitions(seams);
          const arrived = sinceLastCycle(seenDefinitions, definitions);
          seenDefinitions = new Set(definitions.map((each) => each.id));
          if (
            changes.length === 0 &&
            updates.length === 0 &&
            logins.length === 0 &&
            arrived.length === 0
          )
            continue;
          for (const login of logins) {
            context.out.line(
              `  ${context.style.warn('!')} ${login.kind} logged in — ${login.path}`,
            );
            context.out.line(`      ${context.style.dim('memnox protect --for <cli>')}`);
          }
          reportDefinitions(context, arrived, options.json === true);
          await report(context, seams, snapshot, changes, updates, options.json === true);
        }
        between.close();
      },
    );
}

/**
 * What the agents here run on beyond their config, against what anybody accepted.
 *
 * A failure is nothing to report rather than a failed cycle: an unreadable definitions
 * directory must not stop the watch that is reporting everything else.
 */
async function reviewDefinitions(seams: ScanSeams): Promise<SkillFinding[]> {
  try {
    const found = await discoverDefinitions(seams.reader);
    return reviewSkills(found, await readAcceptedSkills(seams.reader.homeDir()));
  } catch {
    return [];
  }
}

/**
 * The ones that arrived since the last cycle. A watch starting on a machine full of
 * definitions reports none of them: what was already there is `memnox skills`, and a
 * watch that opened with three hundred rows is one nobody leaves running.
 */
function sinceLastCycle(
  seen: Set<string> | null,
  findings: readonly SkillFinding[],
): SkillFinding[] {
  if (seen === null) return [];
  return findings.filter(
    (each) => each.standing !== SKILL_STANDING.KNOWN && !seen.has(each.id),
  );
}

/** A roster as one line, and anything else as its own. */
function reportDefinitions(
  context: CliContext,
  arrived: readonly SkillFinding[],
  asJson: boolean,
): void {
  if (arrived.length === 0) return;
  if (asJson) {
    context.out.line(JSON.stringify({ definitions: arrived }));
    return;
  }
  const { out, style } = context;
  const arrivals = bulkArrivals(arrived);
  const grouped = new Set(
    arrivals.flatMap((each) => each.definitions.map((one) => one.id)),
  );
  for (const arrival of arrivals) {
    out.line('');
    out.line(style.warn('⚠ A ROSTER ARRIVED'));
    out.line('');
    out.line(
      `  ${arrival.definitions.length} new ${arrival.agent} definitions in ${arrival.root}`,
    );
    if (arrival.inheriting > 0) {
      out.line(
        `  ${style.warn(`${arrival.inheriting} declare no tools, so each inherits every tool in the session`)}`,
      );
    }
    out.line(`      ${style.dim('memnox skills')}`);
  }
  for (const one of arrived) {
    if (grouped.has(one.id)) continue;
    out.line(`  ${style.warn('!')} ${describeSkill(one)}`);
    out.line(`      ${style.dim('memnox skills')}`);
  }
}

async function report(
  context: CliContext,
  seams: ScanSeams,
  snapshot: EnvironmentSnapshot,
  changes: readonly EnvironmentChange[],
  updates: ReturnType<typeof agentUpdates>,
  asJson: boolean,
): Promise<void> {
  const alerts = alertsFor(changes);
  if (asJson) {
    context.out.line(JSON.stringify({ at: snapshot.takenAt, changes, alerts, updates }));
    return;
  }

  for (const update of updates) {
    context.out.line(`  ${context.style.warn('!')} ${describeUpdate(update)}`);
  }
  // The alert first, then the detail: what to do about it is the line people need.
  for (const alert of alerts) {
    context.out.line(`  ${context.style.warn('!')} ${alert.headline}`);
    context.out.line(`      ${context.style.dim(alert.next)}`);
  }

  for (const change of changes) {
    if (
      change.subject === CHANGE_SUBJECT.SERVER &&
      change.direction === CHANGE_DIRECTION.WIDENS
    ) {
      await reportServer(context, seams, snapshot, change);
      continue;
    }
    reportPlainly(context, change);
  }
}

/** A new server multiplies what every agent reaches, so it gets the whole block. */
async function reportServer(
  context: CliContext,
  seams: ScanSeams,
  snapshot: EnvironmentSnapshot,
  change: EnvironmentChange,
): Promise<void> {
  const { out, style } = context;
  const server = snapshot.servers.find((each) => each.name === change.name);
  const tools = server === undefined ? [] : server.tools;
  const coverage = await rulesCovering(
    seams,
    tools.map((tool) => tool.name),
  );

  out.line('');
  out.line(style.warn('⚠ NEW MCP SERVER'));
  out.line('');
  out.line(`  ${style.bold(change.name)}`);
  out.line('');
  out.line(`  ${change.detail}`);
  out.line('');
  out.line(
    coverage.covered.length === 0
      ? '  No rule covers any of them.'
      : `  ${coverage.covered.length} of ${tools.length} covered by a rule.`,
  );
  /* A file that would not load might have covered these, so the count above is a floor
     rather than a total. Saying which is the difference between a number and a guess. */
  if (coverage.unreadable.length > 0) {
    const broken = coverage.unreadable.length;
    out.line(
      style.warn(
        `  ${broken} rule file${broken === 1 ? '' : 's'} would not load, so that is a floor.`,
      ),
    );
    out.line(`  ${style.dim('run "memnox policy check" to see which')}`);
  }
  if (change.grantedBy !== undefined) {
    out.line('');
    out.line(`  ${style.dim(`«added by ${change.grantedBy}»`)}`);
  }
  out.line('');
}

function reportPlainly(context: CliContext, change: EnvironmentChange): void {
  const { out, style } = context;
  const widens = change.direction === CHANGE_DIRECTION.WIDENS;
  const mark = widens ? style.warn('+') : '-';
  out.line(`${mark} ${change.name} «${change.subject}»  ${change.detail}`);
}

/** Credentials present now that were not there last cycle. A login is an event. */
function newCredentials(
  before: DiscoveryReport | null,
  after: DiscoveryReport,
): CredentialFinding[] {
  if (before === null) return [];
  const had = new Set(before.credentials.map((each) => each.path));
  return after.credentials.filter((each) => !had.has(each.path));
}
